import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { RunsAuthGuard } from "./runs-auth.guard.js";
import { RunsService, type RunView } from "./runs.service.js";

@Controller("runs")
@UseGuards(RunsAuthGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  async list(@Query("limit") limit?: string): Promise<{ runs: RunView[] }> {
    return { runs: await this.runs.recent(limit) };
  }
}
