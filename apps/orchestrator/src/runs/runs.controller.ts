import { Controller, Get, Query } from "@nestjs/common";
import { RunsService, type RunView } from "./runs.service.js";

@Controller("runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  async list(@Query("limit") limit?: string): Promise<{ runs: RunView[] }> {
    return { runs: await this.runs.recent(limit) };
  }
}
