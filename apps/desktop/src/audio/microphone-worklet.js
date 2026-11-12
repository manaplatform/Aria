/* global AudioWorkletProcessor, registerProcessor, sampleRate */
class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.position = 0;
    this.output = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.pending.push(...input);
    const step = sampleRate / 24000;
    while (this.position + 1 < this.pending.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = Math.max(
        -1,
        Math.min(1, this.pending[index] * (1 - fraction) + this.pending[index + 1] * fraction),
      );
      this.output.push(Math.round(value * (value < 0 ? 32768 : 32767)));
      this.position += step;
      if (this.output.length === 480) {
        const buffer = new ArrayBuffer(960);
        const view = new DataView(buffer);
        this.output.forEach((sample, i) => view.setInt16(i * 2, sample, true));
        this.port.postMessage(buffer, [buffer]);
        this.output = [];
      }
    }
    const consumed = Math.floor(this.position);
    this.pending.splice(0, consumed);
    this.position -= consumed;
    return true;
  }
}
registerProcessor('aria-microphone', MicrophoneProcessor);
