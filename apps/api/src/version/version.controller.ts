import { Controller, Get } from "@nestjs/common";
import type { VersionResponse } from "@repo/shared";
import { VersionService } from "./version.service.js";

@Controller("version")
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  @Get()
  get(): VersionResponse {
    return this.versionService.current();
  }
}
