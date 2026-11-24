import { Inject, Injectable } from '@nestjs/common';
import { ConductorLoopExecutor } from './loop-executor';

@Injectable()
export class Conductor {
  constructor(@Inject(ConductorLoopExecutor) private readonly executor: ConductorLoopExecutor) {}

  run(...args: Parameters<ConductorLoopExecutor['run']>) {
    return this.executor.run(...args);
  }

  control(...args: Parameters<ConductorLoopExecutor['control']>) {
    return this.executor.control(...args);
  }
}
