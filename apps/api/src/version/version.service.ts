import { Injectable } from "@nestjs/common";
import { buildVersion, type VersionResponse } from "@repo/shared";

@Injectable()
export class VersionService {
  current(): VersionResponse {
    return buildVersion("api", process.env);
  }
}
