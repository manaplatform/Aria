import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type {
  AgendaObjective,
  AgendaTask,
  agendaTaskDraft,
  agendaObjectiveDraft,
} from '@aria/shared';
import { ProactiveError, type ProactiveStore } from './store';

type TaskDraft = z.infer<typeof agendaTaskDraft>;
type ObjectiveDraft = z.infer<typeof agendaObjectiveDraft>;
type TaskRow = Omit<AgendaTask, keyof TaskDraft> & {
  objective: string | null;
  parent: string | null;
  deadline: number | null;
  priority: TaskDraft['priority'];
  payload: Uint8Array;
  completion: AgendaTask['completedBy'];
};
type ObjectiveRow = Omit<AgendaObjective, keyof ObjectiveDraft> & { payload: Uint8Array };

export class Agenda {
  constructor(
    private readonly store: ProactiveStore,
    private readonly emit: (type: string, id: string, ancestry: string[]) => void,
  ) {}

  taskRow(id: string) {
    return this.store.one<TaskRow>('SELECT * FROM agenda_tasks WHERE id=?', id);
  }
  objectiveRow(id: string) {
    return this.store.one<ObjectiveRow>('SELECT * FROM objectives WHERE id=?', id);
  }

  async task(row: TaskRow): Promise<AgendaTask> {
    const { payload, objective, parent, completion, ...rest } = row;
    const dependencies = this.store.all<{ prerequisite: string }>(
      'SELECT prerequisite FROM task_dependencies WHERE task=? ORDER BY prerequisite',
      row.id,
    );
    return {
      ...rest,
      ...(await this.store.open<Pick<TaskDraft, 'title' | 'description' | 'blocker'>>(payload)),
      completedBy: completion,
      objectiveId: objective,
      parentId: parent,
      dependencies: dependencies.map((item) => item.prerequisite),
    };
  }

  async objective(row: ObjectiveRow): Promise<AgendaObjective> {
    const { payload, ...rest } = row;
    return { ...rest, ...(await this.store.open<ObjectiveDraft>(payload)) };
  }

  async tasks(offset: number, state?: string, priority?: string, query?: string) {
    const rows = this.store.all<TaskRow>(
      `SELECT * FROM agenda_tasks WHERE (? IS NULL OR state=?) AND (? IS NULL OR priority=?)
      ORDER BY updated DESC,id LIMIT ? OFFSET ?`,
      state ?? null,
      state ?? null,
      priority ?? null,
      priority ?? null,
      query ? 60 : 20,
      offset,
    );
    const tasks = await Promise.all(rows.map((row) => this.task(row)));
    return {
      tasks: query
        ? tasks.filter((task) =>
            (task.title + '\n' + task.description).toLowerCase().includes(query.toLowerCase()),
          )
        : tasks,
      next: rows.length === (query ? 60 : 20) ? offset + rows.length : null,
    };
  }

  async objectives(offset: number) {
    return Promise.all(
      this.store
        .all<ObjectiveRow>(
          'SELECT * FROM objectives ORDER BY updated DESC,id LIMIT 20 OFFSET ?',
          offset,
        )
        .map((row) => this.objective(row)),
    );
  }

  prepareTask(task: TaskDraft) {
    return this.store.seal({
      title: task.title,
      description: task.description,
      blocker: task.blocker,
    });
  }

  saveTask(task: TaskDraft, payload: Buffer, id: string = randomUUID(), revision?: number) {
    const old = this.taskRow(id);
    if (revision !== undefined && (!old || old.revision !== revision))
      throw new ProactiveError('conflict', 'The task changed. Reload it to continue.');
    if (old && ['completed', 'cancelled', 'in_progress'].includes(old.state))
      throw new ProactiveError('conflict', 'This task cannot be edited in its current state.');
    if (task.objectiveId && !this.objectiveRow(task.objectiveId))
      throw new ProactiveError('validation', 'The selected objective is unavailable.');
    const parent = task.parentId && this.taskRow(task.parentId);
    if (
      task.parentId &&
      (!parent ||
        parent.objective !== task.objectiveId ||
        ['completed', 'cancelled'].includes(parent.state))
    )
      throw new ProactiveError('validation', 'Choose an open parent task in the same objective.');
    if (
      this.store.one(
        `SELECT 1 FROM agenda_tasks WHERE parent=? AND objective IS NOT ? LIMIT 1`,
        id,
        task.objectiveId,
      )
    )
      throw new ProactiveError('validation', 'Move the subtasks before changing their objective.');
    if (
      parent &&
      this.store.one(
        `WITH RECURSIVE chain(id) AS (
      SELECT ? UNION SELECT t.parent FROM agenda_tasks t JOIN chain c ON t.id=c.id WHERE t.parent IS NOT NULL
      ) SELECT 1 FROM chain WHERE id=?`,
        parent.id,
        id,
      )
    )
      throw new ProactiveError('validation', 'The parent would create a task hierarchy cycle.');

    const prerequisites = [...new Set(task.dependencies)];
    for (const dependency of prerequisites) {
      if (
        dependency === id ||
        !this.taskRow(dependency) ||
        this.store.one(
          `WITH RECURSIVE chain(id) AS (
          SELECT ? UNION SELECT d.prerequisite FROM task_dependencies d JOIN chain c ON d.task=c.id
          UNION SELECT t.id FROM agenda_tasks t JOIN chain c ON t.parent=c.id
        ) SELECT 1 FROM chain WHERE id=?`,
          dependency,
          id,
        )
      )
        throw new ProactiveError(
          'validation',
          'A prerequisite is unavailable or would create a dependency cycle.',
        );
    }
    if (
      (parent &&
        this.store.one(
          `WITH RECURSIVE chain(id) AS (
        SELECT ? UNION SELECT d.prerequisite FROM task_dependencies d JOIN chain c ON d.task=c.id
        UNION SELECT t.id FROM agenda_tasks t JOIN chain c ON t.parent=c.id
      ) SELECT 1 FROM chain WHERE id=?`,
          id,
          parent.id,
        )) ||
      (task.parentId && prerequisites.includes(task.parentId))
    )
      throw new ProactiveError('validation', 'The parent dependency would create a cycle.');
    const now = this.store.now();
    const ready =
      !task.blocker &&
      prerequisites.every((dependency) => this.taskRow(dependency)?.state === 'completed');
    const state = ready ? 'ready' : 'blocked';
    if (old) {
      this.store.run(
        `UPDATE agenda_tasks SET revision=revision+1,state=?,priority=?,objective=?,parent=?,deadline=?,payload=?,updated=?,manual_blocker=? WHERE id=?`,
        state,
        task.priority,
        task.objectiveId,
        task.parentId,
        task.deadline,
        payload,
        now,
        task.blocker ? 1 : 0,
        id,
      );
      this.store.run('DELETE FROM task_dependencies WHERE task=?', id);
    } else {
      this.store.run(
        `INSERT INTO agenda_tasks(id,revision,state,priority,objective,parent,deadline,payload,created,updated,manual_blocker)
        VALUES (?,1,?,?,?,?,?,?,?,?,?)`,
        id,
        state,
        task.priority,
        task.objectiveId,
        task.parentId,
        task.deadline,
        payload,
        now,
        now,
        task.blocker ? 1 : 0,
      );
    }
    for (const prerequisite of prerequisites)
      this.store.run('INSERT INTO task_dependencies VALUES (?,?)', id, prerequisite);
    if (ready && prerequisites.length && old?.state !== 'ready')
      this.emit('task.dependencies_ready', id, []);
    return id;
  }

  saveObjective(payload: Buffer, id: string = randomUUID(), revision?: number) {
    const now = this.store.now();
    if (revision === undefined) {
      this.store.run("INSERT INTO objectives VALUES (?,1,'open',?,?,?)", id, payload, now, now);
    } else {
      const result = this.store.run(
        "UPDATE objectives SET payload=?,updated=?,revision=revision+1 WHERE id=? AND revision=? AND state NOT IN ('completed','cancelled')",
        payload,
        now,
        id,
        revision,
      );
      if (!result.changes)
        throw new ProactiveError('conflict', 'The objective changed or is closed.');
    }
    return id;
  }

  canCompleteTask(id: string) {
    return !this.store.one(
      `SELECT 1 FROM agenda_tasks t WHERE t.state != 'completed'
      AND (t.parent=? OR t.id IN (SELECT prerequisite FROM task_dependencies WHERE task=?)) LIMIT 1`,
      id,
      id,
    );
  }

  completeOrCancel(
    id: string,
    revision: number,
    state: 'completed' | 'cancelled',
    ancestry: string[] = [],
  ) {
    const row = this.taskRow(id);
    if (
      !row ||
      row.revision !== revision ||
      ['completed', 'cancelled'].includes(row.state) ||
      this.store.activeFor('agenda', id).length
    )
      throw new ProactiveError(
        'conflict',
        'Stop active work or reload the task before changing its state.',
      );
    if (state === 'completed' && !this.canCompleteTask(id))
      throw new ProactiveError('conflict', 'Complete the prerequisites and subtasks first.');
    this.store.run(
      'UPDATE agenda_tasks SET state=?,revision=revision+1,updated=?,progress=?,completion=? WHERE id=?',
      state,
      this.store.now(),
      state === 'completed' ? 100 : row.progress,
      state === 'completed' ? 'user' : null,
      id,
    );
    if (state === 'completed') this.completed(id, ancestry);
    return id;
  }

  completed(id: string, ancestry: string[]) {
    this.emit('task.completed', id, ancestry);
    const dependents = this.store.all<{ task: string }>(
      'SELECT task FROM task_dependencies WHERE prerequisite=?',
      id,
    );
    for (const { task } of dependents) {
      if (
        this.store.one(
          `SELECT 1 FROM task_dependencies d JOIN agenda_tasks t ON t.id=d.prerequisite
        WHERE d.task=? AND t.state!='completed' LIMIT 1`,
          task,
        )
      )
        continue;
      const result = this.store.run(
        "UPDATE agenda_tasks SET state='ready',revision=revision+1,updated=? WHERE id=? AND state='blocked' AND manual_blocker=0",
        this.store.now(),
        task,
      );
      if (result.changes) this.emit('task.dependencies_ready', task, ancestry);
    }
  }

  finishObjective(id: string, revision: number, state: 'completed' | 'cancelled') {
    if (
      state === 'completed' &&
      this.store.one(
        "SELECT 1 FROM agenda_tasks WHERE objective=? AND state != 'completed' LIMIT 1",
        id,
      )
    )
      throw new ProactiveError('conflict', 'Complete the objective’s tasks first.');
    if (
      !this.store.run(
        "UPDATE objectives SET state=?,revision=revision+1,updated=? WHERE id=? AND revision=? AND state NOT IN ('completed','cancelled')",
        state,
        this.store.now(),
        id,
        revision,
      ).changes
    )
      throw new ProactiveError('conflict', 'The objective changed or is closed.');
    return id;
  }

  counts() {
    const n = (sql: string) => this.store.one<{ count: number }>(sql)?.count ?? 0;
    return {
      open: n(
        "SELECT count(*) AS count FROM agenda_tasks WHERE state NOT IN ('completed','cancelled')",
      ),
      running: n(
        "SELECT count(*) AS count FROM proactive_jobs WHERE state IN ('running','pausing')",
      ),
      blocked: n(
        "SELECT count(*) AS count FROM proactive_jobs WHERE state IN ('blocked','uncertain','waiting_approval','waiting_user')",
      ),
      objectives: n(
        "SELECT count(*) AS count FROM objectives WHERE state NOT IN ('completed','cancelled')",
      ),
    };
  }
}
