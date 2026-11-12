import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class LocalApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.ARIA_INTERNAL_TOKEN;
    // The standalone API is loopback-only too, and requires an explicitly configured token.
    const actual = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>()
      .headers.authorization;
    if (!token || !actual) throw new UnauthorizedException();
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(actual);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new UnauthorizedException();
    return true;
  }
}
