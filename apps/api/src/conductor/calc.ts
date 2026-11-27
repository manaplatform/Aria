import { evaluateCalculation as evaluate } from '@aria/shared';
import { ToolError } from './capability-host';

export function evaluateCalculation(expression: string, precision?: number) {
  try {
    return evaluate(expression, precision);
  } catch (error) {
    throw new ToolError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid calculation.');
  }
}
