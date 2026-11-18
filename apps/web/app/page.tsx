import { buildHealth, buildVersion } from "@repo/shared";
import { describeVersion, fetchApiHealth, fetchApiVersion } from "@/lib/api";
import { formatUptime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const web = buildHealth("web", process.uptime());
  const webVersion = buildVersion("web", process.env);
  const [apiHealth, apiVersion] = await Promise.all([
    fetchApiHealth(apiUrl),
    fetchApiVersion(apiUrl),
  ]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "48px auto" }}>
      <h1>Agent Factory Starter</h1>
      <p>Pha 0: monorepo sẵn sàng cho AI agent (Turborepo, NestJS, Next.js).</p>

      <h2>Trạng thái</h2>
      <ul>
        <li>
          web: {web.status} ({formatUptime(web.uptimeSeconds)})
        </li>
        <li>
          api:{" "}
          {apiHealth.reachable
            ? `${apiHealth.data.status} (${formatUptime(apiHealth.data.uptimeSeconds)})`
            : `unreachable: ${apiHealth.reason}`}
        </li>
      </ul>

      <h2>Phiên bản đang chạy</h2>
      <ul>
        <li>web: {describeVersion(webVersion)}</li>
        <li>
          api:{" "}
          {apiVersion.reachable
            ? describeVersion(apiVersion.data)
            : `unreachable: ${apiVersion.reason}`}
        </li>
      </ul>
    </main>
  );
}
