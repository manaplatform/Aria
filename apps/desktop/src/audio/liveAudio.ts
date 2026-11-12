export class LiveAudio {
  private context?: AudioContext;
  private stream?: MediaStream;
  private input?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private output = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private closed = false;
  async open(onAudio: (audio: Uint8Array) => void) {
    this.context = new AudioContext({ sampleRate: 24000 });
    await this.context.resume();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('Voice startup was cancelled.');
      }
      this.stream = stream;
      await this.context.audioWorklet.addModule(
        new URL('./microphone-worklet.js', import.meta.url).href,
      );
      if (this.closed) throw new Error('Voice startup was cancelled.');
      this.input = this.context.createMediaStreamSource(stream);
      this.processor = new AudioWorkletNode(this.context, 'aria-microphone');
      this.processor.port.onmessage = (event) => onAudio(new Uint8Array(event.data as ArrayBuffer));
      this.input.connect(this.processor);
      const silent = this.context.createGain();
      silent.gain.value = 0;
      this.processor.connect(silent);
      silent.connect(this.context.destination);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  mute(muted: boolean) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }
  play(base64: string) {
    const context = this.context;
    if (!context || this.closed) return;
    const raw = atob(base64);
    if (raw.length % 2) throw new Error('Invalid voice audio.');
    const buffer = context.createBuffer(1, raw.length / 2, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) {
      const sample = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      channel[i] = (sample >= 32768 ? sample - 65536 : sample) / 32768;
    }
    if (this.nextTime - context.currentTime > 3)
      throw new Error('Voice playback could not keep up.');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.output.add(source);
    source.onended = () => {
      this.output.delete(source);
      source.disconnect();
    };
    const start = Math.max(context.currentTime + 0.02, this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
  }
  interrupt() {
    for (const source of this.output) {
      source.stop();
      source.disconnect();
    }
    this.output.clear();
    this.nextTime = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor?.disconnect();
    this.input?.disconnect();
    if (this.context) void this.context.close().catch(() => undefined);
  }
}
