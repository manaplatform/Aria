import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  computerLimits,
  computerObservation,
  computerOperations,
  computerRuntimeAct,
  type CapabilityHostRequest,
  type ComputerAction,
  type ComputerEnvironment,
  type ComputerObservation,
  type ComputerSessionSummary,
  type ComputerSupervision,
  type MediaAsset,
  type RuntimeResult,
  type RuntimeSettings,
} from '@aria/shared';
import { digest, RuntimeError, type RuntimeStore } from './store';
import { downloadPublicFile, uploadPublicFile } from './downloads';

type Request = Extract<CapabilityHostRequest, { type: 'runtime' }>;
type Capture = { observation: ComputerObservation; bytes?: Uint8Array<ArrayBuffer> };
type InputAction = Exclude<ComputerAction, { type: 'screenshot' | 'wait' }>;
type Status = ComputerSessionSummary['status'];
type OpenInput = ReturnType<(typeof computerOperations)['computer.open']['parse']>;
type Transfer = ReturnType<(typeof computerOperations)['computer.transfer']['parse']>;
const scriptRequest = z.discriminatedUnion('request', [
  z.strictObject({
    request: z.literal('observe'),
    format: z.enum(['structured', 'image']).optional(),
  }),
  z.strictObject({
    request: z.literal('action'),
    index: z
      .number()
      .int()
      .min(0)
      .max(computerLimits.actions - 1),
  }),
]);
const terminal = new Set<Status>(['completed', 'cancelled', 'failed', 'expired']);

function describeInput(action: InputAction) {
  switch (action.type) {
    case 'type':
      return `Type “${action.text}” into the focused control.`;
    case 'set_value':
      return `Replace the authorized editor’s content with “${action.text}”.`;
    case 'keypress':
      return `Press ${action.keys.join(' + ')} in the current window.`;
    case 'click':
      return `${action.button[0].toUpperCase()}${action.button.slice(1)}-click at ${action.x}, ${action.y} in the latest view.`;
    case 'double_click':
      return `Double-click at ${action.x}, ${action.y} in the latest view.`;
    case 'drag': {
      const [start] = action.path;
      const end = action.path.at(-1)!;
      return `Drag from ${start.x}, ${start.y} to ${end.x}, ${end.y} in the latest view.`;
    }
    case 'move':
      return 'Move the pointer within the current view.';
    case 'scroll':
      return 'Scroll within the current view.';
  }
}

export interface ComputerDriver {
  readonly environment: ComputerEnvironment;
  ready(): boolean;
  targetAlive?(owner: string, target: string, id: string): boolean;
  wait?(owner: string, target: string, id: string, signal: AbortSignal): Promise<void>;
  open(owner: string, id: string, input: OpenInput, signal: AbortSignal): Promise<string>;
  restore?(
    owner: string,
    id: string,
    target: string,
    destination: string | undefined,
    signal: AbortSignal,
  ): Promise<string>;
  restoreUrl?(owner: string, target: string, id: string): string | undefined;
  navigate?(
    owner: string,
    id: string,
    input: ReturnType<(typeof computerOperations)['computer.navigate']['parse']>,
    signal: AbortSignal,
  ): Promise<string>;
  authenticate?(owner: string, target: string, id: string, signal: AbortSignal): Promise<string>;
  authenticationSite?(owner: string, target: string, id: string): string;
  observe(
    owner: string,
    target: string,
    id: string,
    image: boolean,
    signal: AbortSignal,
  ): Promise<Capture>;
  input(
    owner: string,
    target: string,
    id: string,
    observation: ComputerObservation,
    action: InputAction,
    signal: AbortSignal,
  ): Promise<void>;
  owner(owner: string, target: string, id: string, user: boolean): void | Promise<void>;
  close(owner: string, target: string, id: string): void | Promise<void>;
  downloadTarget?(
    owner: string,
    target: string,
    id: string,
    observation: ComputerObservation,
    element: string,
    signal: AbortSignal,
  ): Promise<string>;
  uploadTarget?(
    owner: string,
    target: string,
    id: string,
    observation: ComputerObservation,
    element: string,
    signal: AbortSignal,
  ): Promise<{ url: string; field: string }>;
  stage?(id: string, filename: string, bytes: Buffer, signal: AbortSignal): Promise<void>;
  output?(id: string, filename: string, signal: AbortSignal): Promise<Buffer>;
}

type Session = {
  summary: ComputerSessionSummary;
  driver: ComputerDriver;
  provider: string;
  lease: number;
  created: number;
  touched: number;
  active?: { controller: AbortController; done: Promise<RuntimeResult> };
  capture?: Capture;
  userObservation?: ComputerObservation;
  userBusy?: boolean;
  previousDigest?: string;
  repeats: number;
  requestId: string;
  userControlled: boolean;
  privateContents: boolean;
  claimedTargets: Set<string>;
};

export class ComputerRuntime {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Set<string>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: RuntimeStore,
    private readonly drivers: readonly ComputerDriver[],
    private readonly identity: () => string | undefined,
    private readonly foreground: (conversation: string) => boolean,
    private readonly approve: (
      title: string,
      detail: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly changed: (summary: ComputerSessionSummary) => void,
    private readonly files: {
      read(conversation: string, asset: string): Promise<{ asset: MediaAsset; bytes: Buffer }>;
      adopt(
        request: Request,
        session: string,
        name: string,
        bytes: Buffer,
        source: string,
        signal: AbortSignal,
      ): Promise<NonNullable<RuntimeResult['artifact']>>;
      script(
        code: string,
        action: (request: unknown, signal: AbortSignal) => Promise<unknown>,
        signal: AbortSignal,
      ): Promise<string>;
    },
    private readonly settings?: () => RuntimeSettings,
  ) {}

  private get limits() {
    const settings = this.settings?.();
    return {
      idle: (settings?.computerIdleMinutes ?? 20) * 60_000,
      lifetime: (settings?.computerLifetimeMinutes ?? 45) * 60_000,
      batch: settings?.computerBatchLimit ?? computerLimits.actions,
    };
  }

  states(conversation: string) {
    return [...this.sessions.values()]
      .filter(({ summary }) => summary.conversationId === conversation)
      .map(({ summary }) => summary);
  }

  async preview(conversation: string, id: string) {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.summary.conversationId !== conversation ||
      !this.foreground(conversation) ||
      terminal.has(session.summary.status)
    )
      return;
    if (session.summary.status === 'waiting-for-user') {
      if (session.summary.environment !== 'virtual-desktop' || session.userBusy) return;
      const lease = session.lease;
      session.userBusy = true;
      try {
        const signal = AbortSignal.timeout(2000);
        const value = await this.capture(session, true, signal);
        this.guard(session, lease, signal);
        session.userObservation = value.observation;
        return (
          value.bytes && `data:image/png;base64,${Buffer.from(value.bytes).toString('base64')}`
        );
      } finally {
        session.userBusy = false;
      }
    }
    const bytes = session.capture?.bytes;
    return bytes && `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  }

  async userInput(conversation: string, id: string, action: ComputerAction) {
    const session = this.sessions.get(id);
    if (
      !session ||
      !session.userControlled ||
      session.summary.status !== 'waiting-for-user' ||
      session.summary.conversationId !== conversation ||
      session.summary.environment !== 'virtual-desktop' ||
      !session.userObservation ||
      session.userBusy ||
      action.type === 'screenshot' ||
      action.type === 'wait'
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Take control of the virtual desktop before sending input.',
      );
    const signal = AbortSignal.timeout(computerLimits.actionMs);
    this.guard(session, session.lease, signal);
    session.userBusy = true;
    const controller = new AbortController();
    const done = session.driver
      .input(
        ...this.driverSession(session),
        session.userObservation,
        action,
        AbortSignal.any([controller.signal, signal]),
      )
      .then(() => ({}));
    session.active = { controller, done };
    try {
      await done;
    } finally {
      if (session.active?.controller === controller) session.active = undefined;
      session.userBusy = false;
    }
  }

  private state(session: Session, status: Status, operation?: string) {
    session.summary = { ...session.summary, status, operation };
    session.touched = Date.now();
    this.store.db
      .prepare('UPDATE computer_sessions SET state = ?, touched = ?, lease = ? WHERE id = ?')
      .run(status, session.touched, session.lease, session.summary.id);
    this.changed(session.summary);
  }

  private note(session: Session, action: string, outcome: string) {
    session.summary = {
      ...session.summary,
      history: [...session.summary.history, { at: Date.now(), action, outcome }].slice(-24),
    };
    this.changed(session.summary);
  }

  private driverSession(session: Session) {
    const { conversationId, targetId, id } = session.summary;
    return [conversationId, targetId, id] as const;
  }

  private guard(session: Session, lease: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      session.lease !== lease ||
      !session.driver.ready() ||
      session.driver.targetAlive?.(...this.driverSession(session)) === false ||
      !this.foreground(session.summary.conversationId) ||
      session.provider !== this.identity() ||
      Date.now() - session.created >= this.limits.lifetime
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'The computer session lease is no longer authorized.',
      );
  }

  private async capture(session: Session, image: boolean, signal: AbortSignal) {
    const value = await session.driver.observe(...this.driverSession(session), image, signal);
    computerObservation.parse(value.observation);
    if (
      value.bytes &&
      (!value.observation.screenshot || value.bytes.length > computerLimits.imageBytes)
    )
      throw new RuntimeError('BUDGET_EXCEEDED', 'The driver returned an invalid screenshot.');
    return value;
  }

  private captureDigest(value: Capture) {
    const { revision, width, height, devicePixelRatio, state } = value.observation;
    return digest(
      JSON.stringify([
        revision,
        width,
        height,
        devicePixelRatio,
        state,
        value.bytes && digest(Buffer.from(value.bytes)),
      ]),
    );
  }

  private remember(session: Session, capture: Capture) {
    const hash = this.captureDigest(capture);
    session.repeats = session.previousDigest === hash ? session.repeats + 1 : 0;
    session.previousDigest = hash;
    session.capture = capture;
    if (session.repeats >= 3)
      throw new RuntimeError(
        'BUDGET_EXCEEDED',
        'The interface has not changed across repeated observations.',
      );
    this.changed(session.summary);
    return capture;
  }

  private result(capture: Capture): RuntimeResult {
    const { observation, bytes } = capture;
    return { data: { observation }, ...(bytes && { computerImage: { observation, bytes } }) };
  }

  async dispatch(request: Request, signal: AbortSignal): Promise<RuntimeResult> {
    if (request.operation === 'computer.inspect') {
      const browser = this.drivers.some(
        (item) => item.environment === 'managed-browser' && item.ready(),
      );
      return {
        data: {
          environments: [
            {
              environment: 'managed-browser',
              available: browser,
              ...(browser
                ? {
                    actions: [
                      'screenshot',
                      'click',
                      'double_click',
                      'move',
                      'drag',
                      'scroll',
                      'keypress',
                      'type',
                      'wait',
                    ],
                    scope: 'Public AI tab with network suspended during visual interaction',
                  }
                : { reason: 'Enable AI Browser in Web & Browser settings.' }),
            },
            ...(['virtual-desktop', 'local-desktop'] as const).map((environment) => ({
              environment,
              available: this.drivers.some(
                (item) => item.environment === environment && item.ready(),
              ),
              actions:
                environment === 'local-desktop'
                  ? ['set_value', 'screenshot']
                  : [
                      'screenshot',
                      'click',
                      'double_click',
                      'move',
                      'drag',
                      'scroll',
                      'keypress',
                      'type',
                      'wait',
                    ],
            })),
          ],
          sessions: this.states(request.conversationId).map(
            ({ id, environment, mode, status, targetId }) => ({
              id,
              environment,
              mode,
              status,
              targetId,
            }),
          ),
          recoverable: this.store.db
            .prepare(
              `SELECT id, environment FROM computer_sessions WHERE conversation = ? AND provider = ?
        AND state IN ('recovering', 'failed') AND created > ? AND environment <> 'local-desktop' ORDER BY touched DESC LIMIT 4`,
            )
            .all(
              request.conversationId,
              this.identity() ?? '',
              Date.now() - computerLimits.lifetimeMs,
            ),
        },
      };
    }
    const owner = request.conversationId;
    if (!this.foreground(owner))
      throw new RuntimeError('PERMISSION_DENIED', 'Bring the owning chat to the foreground.');
    if (request.operation === 'computer.open') return this.open(request, signal);
    const operation = request.operation;
    if (
      operation !== 'computer.close' &&
      operation !== 'computer.observe' &&
      operation !== 'computer.act' &&
      operation !== 'computer.transfer' &&
      operation !== 'computer.run_script' &&
      operation !== 'computer.navigate'
    )
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'This computer operation is unavailable.');
    const parsed = (
      operation === 'computer.act' ? computerRuntimeAct : computerOperations[operation]
    ).safeParse(request.input);
    if (!parsed.success)
      throw new RuntimeError('INVALID_ARGUMENT', 'The computer operation has invalid arguments.');
    const session = this.sessions.get(parsed.data.sessionId);
    if (!session || session.summary.conversationId !== owner)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Open an authorized computer session for this conversation.',
      );
    this.guard(session, session.lease, signal);
    if (operation === 'computer.close') {
      if (session.userControlled)
        throw new RuntimeError('PERMISSION_DENIED', 'The user currently controls this session.');
      await this.close(session, 'completed');
      return { data: { sessionId: session.summary.id, status: 'completed' } };
    }
    if (session.active || session.summary.status !== 'ready')
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The session is busy, paused, or controlled by the user.',
      );
    if (session.requestId !== request.requestId) {
      session.requestId = request.requestId;
      session.capture = undefined;
      session.previousDigest = undefined;
      session.repeats = 0;
    }
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    const lease = session.lease;
    const label =
      operation === 'computer.observe'
        ? 'Observing interface'
        : operation === 'computer.transfer'
          ? 'Preparing file transfer'
          : operation === 'computer.run_script'
            ? 'Running bounded computer script'
            : operation === 'computer.navigate'
              ? 'Navigating browser'
              : 'Interacting with interface';
    this.state(session, 'running', label);
    const done =
      operation === 'computer.observe'
        ? this.capture(
            session,
            computerOperations[operation].parse(request.input).format === 'image',
            active,
          ).then(async (value) => {
            this.guard(session, lease, active);
            await this.authorizeImage(session, request, value, lease, active);
            return this.result(this.remember(session, value));
          })
        : operation === 'computer.navigate'
          ? this.navigate(session, computerOperations[operation].parse(request.input), active)
          : operation === 'computer.transfer'
            ? this.transfer(
                session,
                request,
                computerOperations[operation].parse(request.input),
                active,
              )
            : operation === 'computer.run_script'
              ? this.script(
                  session,
                  request,
                  computerOperations[operation].parse(request.input),
                  active,
                )
              : this.actions(session, request, computerRuntimeAct.parse(request.input), active);
    session.active = { controller, done };
    try {
      return await done;
    } finally {
      session.active = undefined;
      if (session.lease === lease && !terminal.has(session.summary.status))
        this.state(session, 'ready');
    }
  }

  private async navigate(
    session: Session,
    input: ReturnType<(typeof computerOperations)['computer.navigate']['parse']>,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    if (!session.driver.navigate)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'This environment cannot navigate browser tabs.',
      );
    const previous = this.driverSession(session);
    const lease = session.lease;
    let target: string | undefined;
    try {
      session.capture = undefined;
      target = await session.driver.navigate(
        session.summary.conversationId,
        session.summary.id,
        input,
        signal,
      );
      this.guard(session, lease, signal);
      session.summary = { ...session.summary, targetId: target };
      session.claimedTargets.add(target);
      this.store.db
        .prepare('UPDATE computer_sessions SET target = ?, restore_url = ? WHERE id = ?')
        .run(
          target,
          session.driver.restoreUrl?.(...this.driverSession(session)) ?? null,
          session.summary.id,
        );
      this.note(session, 'Navigate', 'Browser target loaded');
      return { data: { sessionId: session.summary.id, targetId: target, status: 'ready' } };
    } catch (error) {
      if (target) await session.driver.close(previous[0], target, previous[2]);
      throw error;
    }
  }

  private async script(
    session: Session,
    request: Request,
    input: ReturnType<(typeof computerOperations)['computer.run_script']['parse']>,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const lease = session.lease;
    const dispatched = new Set<number>();
    const output = await this.files.script(
      input.script,
      async (value, active) => {
        this.guard(session, lease, active);
        const parsed = scriptRequest.safeParse(value);
        if (!parsed.success)
          throw new RuntimeError(
            'PERMISSION_DENIED',
            'The script requested an operation outside its computer broker.',
          );
        if (parsed.data.request === 'observe') {
          if (session.privateContents && parsed.data.format === 'image')
            throw new RuntimeError(
              'PERMISSION_DENIED',
              'Private frames are unavailable to computer scripts.',
            );
          const capture = await this.capture(session, parsed.data.format === 'image', active);
          this.guard(session, lease, active);
          return this.remember(session, capture).observation;
        }
        const { index } = parsed.data;
        const action = input.actions?.[index];
        if (!action || action.type === 'screenshot' || dispatched.has(index))
          throw new RuntimeError(
            'PERMISSION_DENIED',
            'The script requested an undeclared or already dispatched action.',
          );
        const observation = session.capture?.observation;
        if (!observation)
          throw new RuntimeError(
            'INVALID_ARGUMENT',
            'The script must request an observation before input.',
          );
        dispatched.add(index);
        const step = await this.actions(
          session,
          request,
          {
            sessionId: session.summary.id,
            observationId: observation.id,
            actions: [action],
          },
          active,
        );
        const status = z.array(z.object({ status: z.string() })).safeParse(step.data?.outcomes);
        if (
          step.commandProblem ||
          !status.success ||
          !status.data.every((item) => ['submitted', 'waited'].includes(item.status))
        )
          throw new RuntimeError(
            step.commandProblem?.code ?? 'PERMISSION_DENIED',
            step.commandProblem?.message ?? 'The script stopped at a changed or unapproved action.',
          );
        return step.data;
      },
      signal,
    );
    this.guard(session, lease, signal);
    return { data: { output, dispatched: dispatched.size } };
  }

  private async transfer(
    session: Session,
    request: Request,
    input: Transfer,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const lease = session.lease;
    const id = session.summary.id;
    if (input.direction === 'save_capture') {
      const frame = session.capture;
      if (!frame?.bytes || frame.observation.id !== input.observationId)
        throw new RuntimeError(
          'INVALID_ARGUMENT',
          'Capture a current screenshot before saving it.',
        );
      if (session.privateContents) {
        this.state(session, 'waiting-for-approval', 'Approve retaining the selected screenshot');
        if (
          !(await this.approve(
            'Save the selected frame to this conversation?',
            'The approved frame will remain available until its artifact retention period ends.',
            AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          ))
        )
          throw new RuntimeError('PERMISSION_DENIED', 'Screenshot retention was declined.');
      }
      this.guard(session, lease, signal);
      const artifact = await this.files.adopt(
        request,
        id,
        'computer-observation.png',
        Buffer.from(frame.bytes),
        `observation:${frame.observation.id}`,
        signal,
      );
      this.note(session, 'Save screenshot', 'Artifact verified');
      return { artifact };
    }
    if (input.direction === 'upload' && session.driver.uploadTarget) {
      const observation = session.capture?.observation;
      if (!observation || observation.id !== input.observationId)
        throw new RuntimeError(
          'INVALID_ARGUMENT',
          'Read the current upload control before preparing the transfer.',
        );
      const owner = session.summary.conversationId;
      const { asset, bytes } = await this.files.read(owner, input.fileId);
      const version = digest(bytes);
      const destination = await session.driver.uploadTarget(
        ...this.driverSession(session),
        observation,
        input.elementId,
        signal,
      );
      this.state(session, 'waiting-for-approval', 'Approve sending the selected attachment');
      if (
        !(await this.approve(
          'Send this attachment to the website?',
          `${asset.name} (${asset.size} bytes)\n\n${destination.url}\n\nThe site will receive the entire file.`,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        ))
      )
        throw new RuntimeError('PERMISSION_DENIED', 'The upload was declined.');
      this.guard(session, lease, signal);
      const checked = await session.driver.uploadTarget(
        ...this.driverSession(session),
        observation,
        input.elementId,
        signal,
      );
      if (
        checked.url !== destination.url ||
        checked.field !== destination.field ||
        digest((await this.files.read(owner, input.fileId)).bytes) !== version
      )
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'The destination or file changed after approval.',
        );
      this.guard(session, lease, signal);
      const attempt = this.store.begin(request, id, [
        'upload',
        destination.url,
        destination.field,
        asset.id,
        version,
      ]);
      try {
        this.state(session, 'running', 'Uploading attachment');
        const code = await uploadPublicFile(
          destination.url,
          destination.field,
          asset.name,
          asset.mimeType,
          bytes,
          signal,
        );
        this.store.finish(attempt, 'submitted');
        this.note(session, 'Upload', 'Server accepted the request');
        return {
          data: { status: 'submitted', code, destination: new URL(destination.url).origin },
        };
      } catch (error) {
        this.store.finish(attempt, 'uncertain');
        throw error;
      }
    }
    if (input.direction === 'stage' && session.driver.stage) {
      const owner = session.summary.conversationId;
      const { asset, bytes } = await this.files.read(owner, input.fileId);
      const version = digest(bytes);
      this.state(session, 'waiting-for-approval', 'Approve staging the selected file');
      if (
        !(await this.approve(
          'Stage a file in the isolated desktop?',
          asset.name,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        ))
      )
        throw new RuntimeError('PERMISSION_DENIED', 'The file transfer was declined.');
      this.guard(session, lease, signal);
      if (digest((await this.files.read(owner, input.fileId)).bytes) !== version)
        throw new RuntimeError('PERMISSION_DENIED', 'The file changed after approval.');
      const name = `${asset.id}-${asset.name.replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 100)}`;
      const attempt = this.store.begin(request, id, ['stage', asset.id, version]);
      try {
        this.guard(session, lease, signal);
        await session.driver.stage(id, name, bytes, signal);
        session.privateContents = true;
        this.store.finish(attempt, 'staged');
        this.note(session, 'Stage input', 'File staged');
        return { data: { fileId: asset.id, version, path: `/workspace/inputs/${name}` } };
      } catch (error) {
        this.store.finish(attempt, 'uncertain');
        throw error;
      }
    }
    if (input.direction === 'publish' && session.driver.output) {
      const bytes = await session.driver.output(id, input.filename, signal);
      this.guard(session, lease, signal);
      const artifact = await this.files.adopt(
        request,
        id,
        input.filename,
        bytes,
        'virtual-desktop',
        signal,
      );
      this.note(session, 'Publish output', 'Artifact verified');
      return { artifact };
    }
    if (input.direction === 'download' && session.driver.downloadTarget) {
      const observation = session.capture?.observation;
      if (!observation || observation.id !== input.observationId)
        throw new RuntimeError(
          'INVALID_ARGUMENT',
          'Read the current structured observation before downloading a file.',
        );
      const target = await session.driver.downloadTarget(
        ...this.driverSession(session),
        observation,
        input.elementId,
        signal,
      );
      const url = new URL(target);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      )
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'Only direct public HTTPS links without credentials or query parameters can be downloaded.',
        );
      this.state(session, 'waiting-for-approval', 'Approve downloading the selected file');
      if (
        !(await this.approve(
          'Download this public file?',
          `${url.href}\n\nSave as ${input.filename} in this conversation.`,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        ))
      )
        throw new RuntimeError('PERMISSION_DENIED', 'The download was declined.');
      this.guard(session, lease, signal);
      if (
        (await session.driver.downloadTarget(
          ...this.driverSession(session),
          observation,
          input.elementId,
          signal,
        )) !== target
      )
        throw new RuntimeError('PERMISSION_DENIED', 'The link changed while approval was pending.');
      this.guard(session, lease, signal);
      const attempt = this.store.begin(request, id, ['download', url.href, input.filename]);
      try {
        this.state(session, 'running', 'Downloading file');
        const bytes = await downloadPublicFile(url.href, signal);
        this.guard(session, lease, signal);
        const artifact = await this.files.adopt(
          request,
          id,
          input.filename,
          bytes,
          url.href,
          signal,
        );
        this.store.finish(attempt, 'confirmed');
        this.note(session, 'Download', 'Artifact verified');
        return { artifact };
      } catch (error) {
        this.store.finish(attempt, 'failed');
        throw error;
      }
    }
    throw new RuntimeError(
      'CAPABILITY_UNAVAILABLE',
      'This file exchange is unavailable for the selected environment.',
    );
  }

  private async open(request: Request, signal: AbortSignal): Promise<RuntimeResult> {
    const input = computerOperations['computer.open'].safeParse(request.input);
    if (!input.success)
      throw new RuntimeError('INVALID_ARGUMENT', 'The computer environment request is invalid.');
    const { environment, mode, tabId, restoreId, resumeId } = input.data;
    const owner = request.conversationId;
    const provider = this.identity();
    const driver = this.drivers.find((item) => item.environment === environment && item.ready());
    if (!driver || !provider)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The selected environment has no verified driver.',
      );
    if (resumeId) {
      const session = this.sessions.get(resumeId);
      if (
        !session ||
        session.summary.conversationId !== owner ||
        session.summary.status !== 'ready' ||
        session.active ||
        session.summary.mode !== mode ||
        session.summary.environment !== environment
      )
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'This session cannot resume automated input.',
        );
      this.guard(session, session.lease, signal);
      session.requestId = request.requestId;
      session.capture = undefined;
      session.previousDigest = undefined;
      session.repeats = 0;
      this.state(session, 'ready');
      return {
        data: {
          sessionId: resumeId,
          environment,
          mode,
          targetId: session.summary.targetId,
          status: 'ready',
        },
      };
    }
    if (
      this.opening.has(owner) ||
      [...this.sessions.values()].some(
        ({ summary }) => summary.conversationId === owner && !terminal.has(summary.status),
      )
    )
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Close the active computer session before opening another.',
      );
    if (this.sessions.size + this.opening.size >= computerLimits.sessions)
      throw new RuntimeError('BUDGET_EXCEEDED', 'All computer sessions are in use.');
    if (environment === 'managed-browser' && !tabId && !restoreId)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'First open an authorized URL with browser_open and use its tab ID.',
      );
    const prior =
      restoreId &&
      this.store.db
        .prepare(
          `SELECT * FROM computer_sessions WHERE id = ? AND conversation = ? AND provider = ?
      AND environment = ? AND mode = ? AND state IN ('recovering', 'failed') AND created > ?`,
        )
        .get(restoreId, owner, provider, environment, mode, Date.now() - computerLimits.lifetimeMs);
    if (restoreId && (!prior || !driver.restore))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'This environment cannot restore the selected session.',
      );
    const id = restoreId ?? randomUUID();
    const created = prior ? Number(prior.created) : Date.now();
    const lease = prior ? Number(prior.lease) + 1 : 1;
    this.opening.add(owner);
    let target: string | undefined;
    try {
      if (prior && driver.restore) {
        if (
          !(await this.approve(
            'Restore this computer session?',
            `${environment}\nInspect the current state after restoring. Earlier actions may already have taken effect.`,
            AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          ))
        )
          throw new RuntimeError('PERMISSION_DENIED', 'Session restoration was declined.');
        this.store.db
          .prepare("UPDATE computer_sessions SET state = 'initializing', lease = ? WHERE id = ?")
          .run(lease, id);
        target = await driver.restore(
          owner,
          id,
          String(prior.target),
          typeof prior.restore_url === 'string' ? prior.restore_url : undefined,
          signal,
        );
      } else {
        this.store.db
          .prepare(
            `INSERT INTO computer_sessions VALUES (?, ?, ?, ?, ?, ?, 'initializing', ?, ?, ?, NULL)`,
          )
          .run(id, owner, environment, tabId ?? id, provider, mode, lease, created, created);
        target = await driver.open(owner, id, input.data, signal);
      }
      signal.throwIfAborted();
      if (!this.foreground(owner) || provider !== this.identity())
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'The owning chat or configured primary changed.',
        );
      this.store.db
        .prepare('UPDATE computer_sessions SET target = ?, restore_url = ? WHERE id = ?')
        .run(target, driver.restoreUrl?.(owner, target, id) ?? null, id);
      const session: Session = {
        summary: {
          id,
          conversationId: owner,
          environment,
          mode,
          targetId: target,
          status: 'initializing',
          history: [],
        },
        driver,
        provider,
        lease,
        created,
        touched: Date.now(),
        repeats: 0,
        requestId: request.requestId,
        userControlled: false,
        privateContents: environment === 'local-desktop',
        claimedTargets: new Set([target]),
      };
      this.sessions.set(id, session);
      this.state(session, 'ready');
      this.sweepTimer ??= setInterval(() => void this.sweep(), 15_000);
      this.sweepTimer.unref();
      return {
        data: {
          sessionId: id,
          environment,
          mode,
          targetId: target,
          status: 'ready',
          ...(prior && { needsVerification: true }),
        },
      };
    } catch (error) {
      if (target) await driver.close(owner, target, id);
      this.sessions.delete(id);
      this.store.db.prepare("UPDATE computer_sessions SET state = 'failed' WHERE id = ?").run(id);
      throw error;
    } finally {
      this.opening.delete(owner);
    }
  }

  private async authorizeImage(
    session: Session,
    request: Request,
    capture: Capture,
    lease: number,
    signal: AbortSignal,
  ) {
    if (!capture.bytes || !session.privateContents) return;
    this.state(session, 'waiting-for-approval', 'Approve sharing this observation');
    if (
      !(await this.approve(
        'Share this computer observation?',
        `Allow the current ${capture.observation.title || session.summary.environment} frame to be sent once to ${new URL(request.primary.endpoint).origin}. Review the target before approving.`,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      ))
    )
      throw new RuntimeError('PERMISSION_DENIED', 'The image release was declined.');
    this.guard(session, lease, signal);
    this.state(session, 'running', 'Observing interface');
  }

  private async actions(
    session: Session,
    request: Request,
    input: ReturnType<typeof computerRuntimeAct.parse>,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    if (input.actions.length > this.limits.batch)
      throw new RuntimeError('BUDGET_EXCEEDED', 'The action batch exceeds the configured limit.');
    let reference = session.capture;
    if (
      input.actions.some(({ type }) => type !== 'screenshot') &&
      (!input.observationId || reference?.observation.id !== input.observationId)
    )
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Use the latest observation ID from this computer session.',
      );
    const lease = session.lease;
    const outcomes: { index: number; action: string; status: string }[] = [];
    let problem: RuntimeResult['commandProblem'];
    const provider = input.provider;
    if (
      provider &&
      (session.summary.mode !== 'openai-responses' || provider.callId !== request.callId)
    )
      throw new RuntimeError('PERMISSION_DENIED', 'The provider call does not own this session.');
    if (provider) {
      const saved = this.store.db
        .prepare(
          `INSERT OR IGNORE INTO computer_provider_calls VALUES (?, ?, ?, ?, ?, NULL, 'received')`,
        )
        .run(
          session.summary.id,
          provider.responseId,
          provider.itemId,
          provider.callId,
          request.stepId,
        );
      if (saved.changes !== 1)
        throw new RuntimeError(
          'DUPLICATE_DISPATCH',
          'This provider computer call has already been received.',
        );
    }
    if (provider?.checks.length) {
      this.state(session, 'waiting-for-approval', 'Review provider safety checks');
      const approved = await this.approve(
        'Review computer safety checks',
        provider.checks
          .map(({ code, message }) => [code, message].filter(Boolean).join(' — '))
          .join('\n')
          .slice(0, 2400),
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      );
      this.guard(session, lease, signal);
      this.store.db
        .prepare('INSERT INTO computer_approvals VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          randomUUID(),
          session.summary.id,
          request.stepId,
          digest(JSON.stringify([lease, provider, input.actions])),
          approved ? 'approved' : 'declined',
          Date.now(),
        );
      if (!approved)
        throw new RuntimeError('PERMISSION_DENIED', 'The provider safety checks were declined.');
      this.state(session, 'running', 'Interacting with interface');
    }
    for (const [index, action] of input.actions.entries()) {
      this.guard(session, lease, signal);
      const active = AbortSignal.any([signal, AbortSignal.timeout(computerLimits.actionMs)]);
      if (action.type === 'screenshot') {
        reference = await this.capture(session, true, active);
        outcomes.push({ index, action: action.type, status: 'observed' });
        continue;
      }
      if (action.type === 'wait') {
        if (session.driver.wait) await session.driver.wait(...this.driverSession(session), active);
        else await sleep(300, undefined, { signal: active });
        outcomes.push({ index, action: action.type, status: 'waited' });
        continue;
      }
      if (!reference) break;
      const current = await this.capture(session, !!reference.bytes, active);
      if (this.captureDigest(reference) !== this.captureDigest(current)) {
        reference = current;
        outcomes.push({ index, action: action.type, status: 'stale-observation' });
        this.note(session, action.type, 'Stopped on changed interface');
        break;
      }
      const signature = digest(
        JSON.stringify([session.summary.targetId, this.captureDigest(reference), action]),
      );
      if (action.type !== 'move' && action.type !== 'scroll') {
        this.state(session, 'waiting-for-approval', `Approve ${action.type.replace('_', ' ')}`);
        const consent = describeInput(action);
        const approved = await this.approve(
          'Allow this computer action once?',
          `${reference.observation.url ?? session.summary.environment}\n\n${consent}\n\nThis sends input to the current target.`,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        );
        this.guard(session, lease, signal);
        this.store.db
          .prepare('INSERT INTO computer_approvals VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            randomUUID(),
            session.summary.id,
            request.stepId,
            signature,
            approved ? 'approved' : 'declined',
            Date.now(),
          );
        if (!approved) {
          outcomes.push({ index, action: action.type, status: 'declined' });
          this.note(session, action.type, 'Declined');
          break;
        }
        const checked = await this.capture(
          session,
          !!reference.bytes,
          AbortSignal.any([signal, AbortSignal.timeout(computerLimits.actionMs)]),
        );
        if (this.captureDigest(reference) !== this.captureDigest(checked)) {
          reference = checked;
          outcomes.push({ index, action: action.type, status: 'stale-approval' });
          break;
        }
        this.state(session, 'running', `Interacting with interface`);
      }
      this.guard(session, lease, signal);
      const attempt = this.store.begin(request, session.summary.id, ['computer', signature]);
      try {
        await session.driver.input(
          ...this.driverSession(session),
          reference.observation,
          action,
          AbortSignal.any([signal, AbortSignal.timeout(computerLimits.actionMs)]),
        );
        this.store.finish(attempt, 'submitted');
        outcomes.push({ index, action: action.type, status: 'submitted' });
        this.note(session, action.type, 'Input dispatched');
      } catch (error) {
        const checked = error instanceof RuntimeError;
        this.store.finish(attempt, checked ? 'failed' : 'uncertain');
        outcomes.push({ index, action: action.type, status: checked ? 'failed' : 'unknown' });
        problem = checked
          ? { code: 'EXECUTION_FAILED', message: error.message }
          : {
              code: 'OUTCOME_UNCERTAIN',
              message:
                'Input may have reached the interface. Inspect the target before trying again.',
            };
        break;
      }
    }
    this.guard(session, lease, signal);
    const updated = await this.capture(
      session,
      !!input.screenshot || input.actions.some(({ type }) => type === 'screenshot'),
      signal,
    );
    await this.authorizeImage(session, request, updated, lease, signal);
    this.remember(session, updated);
    if (provider)
      this.store.db
        .prepare(
          'UPDATE computer_provider_calls SET observation = ?, state = ? WHERE session = ? AND response = ? AND call = ?',
        )
        .run(
          updated.observation.id,
          problem ? 'uncertain' : 'observed',
          session.summary.id,
          provider.responseId,
          provider.callId,
        );
    const result = this.result(updated);
    return {
      ...result,
      data: {
        ...result.data,
        outcomes,
        status: problem ? 'unknown' : 'observed',
        ...(provider && { acknowledged: provider.checks }),
      },
      commandProblem: problem,
    };
  }

  async supervise(conversation: string, command: ComputerSupervision) {
    const session = this.sessions.get(command.sessionId);
    if (
      !session ||
      session.summary.conversationId !== conversation ||
      !this.foreground(conversation)
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Select the conversation that owns this session.',
      );
    if (command.action === 'close' || command.action === 'stop') {
      await this.close(session, command.action === 'stop' ? 'cancelled' : 'completed');
      return;
    }
    session.lease++;
    const lease = session.lease;
    session.capture = undefined;
    session.userObservation = undefined;
    session.previousDigest = undefined;
    session.repeats = 0;
    this.state(session, 'paused');
    const running = session.active;
    running?.controller.abort();
    await running?.done.catch(() => undefined);
    if (terminal.has(session.summary.status) || session.lease !== lease) return;
    if (command.action === 'private-auth') {
      if (!session.driver.authenticate)
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'This environment does not provide a private sign-in view.',
        );
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(80_000)]);
      const previous = this.driverSession(session);
      const done = (async (): Promise<RuntimeResult> => {
        const site = session.driver.authenticationSite?.(...previous);
        if (
          !site ||
          !(await this.approve(
            'Open a private sign-in view?',
            `You will control the page on ${new URL(site).origin}. Passwords and security challenges stay in the private view.`,
            signal,
          ))
        )
          throw new RuntimeError('PERMISSION_DENIED', 'The private sign-in was declined.');
        this.guard(session, lease, signal);
        const target = await session.driver.authenticate!(...previous, signal);
        try {
          this.guard(session, lease, signal);
        } catch (error) {
          await session.driver.close(previous[0], target, previous[2]);
          throw error;
        }
        session.summary = { ...session.summary, targetId: target };
        session.claimedTargets.add(target);
        session.userControlled = true;
        session.privateContents = true;
        this.store.db
          .prepare('UPDATE computer_sessions SET target = ?, restore_url = NULL WHERE id = ?')
          .run(target, session.summary.id);
        await session.driver.close(...previous);
        session.claimedTargets.delete(previous[1]);
        this.state(session, 'waiting-for-user');
        return {};
      })();
      session.active = { controller, done };
      try {
        await done;
      } finally {
        if (session.active?.controller === controller) session.active = undefined;
      }
      return;
    }
    if (command.action === 'take-control') {
      await session.driver.owner(...this.driverSession(session), true);
      if (session.lease !== lease) return;
      session.userControlled = true;
      session.privateContents = true;
      this.state(session, 'waiting-for-user');
    } else if (command.action === 'return-control' || command.action === 'resume') {
      await session.driver.owner(...this.driverSession(session), false);
      if (session.lease !== lease) return;
      session.userControlled = false;
      this.state(session, 'ready');
    }
  }

  release(requestId: string) {
    for (const session of this.sessions.values()) {
      if (session.requestId !== requestId) continue;
      session.active?.controller.abort();
      session.capture = undefined;
      session.userObservation = undefined;
    }
  }

  leave(conversation: string) {
    for (const session of this.sessions.values()) {
      if (session.summary.conversationId !== conversation || terminal.has(session.summary.status))
        continue;
      session.lease++;
      session.capture = undefined;
      session.active?.controller.abort();
      this.state(session, 'paused');
    }
  }

  private async close(session: Session, status: Status) {
    if (terminal.has(session.summary.status)) return;
    session.lease++;
    this.state(session, status);
    const running = session.active;
    running?.controller.abort();
    await running?.done.catch(() => undefined);
    try {
      await Promise.allSettled(
        [...session.claimedTargets].map((target) =>
          session.driver.close(session.summary.conversationId, target, session.summary.id),
        ),
      );
    } finally {
      this.sessions.delete(session.summary.id);
    }
  }

  private async sweep() {
    const now = Date.now();
    const limits = this.limits;
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter(
          (session) =>
            now - session.created >= limits.lifetime ||
            now - session.touched >= limits.idle ||
            !session.driver.ready() ||
            session.driver.targetAlive?.(...this.driverSession(session)) === false ||
            session.provider !== this.identity(),
        )
        .map((session) => this.close(session, 'expired')),
    );
  }

  async shutdown() {
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.close(session, 'cancelled')),
    );
  }
}
