import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { APP_CONFIG, type OrchestratorConfig } from "../config/config.js";

export type RunsAccess = "ok" | "unauthorized" | "forbidden";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * With RUNS_API_TOKEN set: `Authorization: Bearer <token>` is required.
 * Without it: only loopback peers (the socket address, never X-Forwarded-For).
 */
export function checkRunsAccess(
  authorization: string | undefined,
  remoteAddress: string | undefined,
  token: string | null,
): RunsAccess {
  if (token) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    // Hashing first gives equal lengths, so the comparison is constant time.
    return match?.[1] && timingSafeEqual(digest(match[1]), digest(token)) ? "ok" : "unauthorized";
  }
  return remoteAddress && LOOPBACK.has(remoteAddress) ? "ok" : "forbidden";
}

@Injectable()
export class RunsAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: OrchestratorConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    const access = checkRunsAccess(
      request.headers.authorization,
      request.socket.remoteAddress,
      this.config.runsApiToken,
    );
    if (access === "unauthorized") throw new UnauthorizedException("Bearer token required");
    if (access === "forbidden") {
      throw new ForbiddenException("Set RUNS_API_TOKEN to read runs from another host");
    }
    return true;
  }
}
