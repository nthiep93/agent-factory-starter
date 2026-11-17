import { buildHealth } from "@repo/shared";
import { fetchApiHealth } from "@/lib/api";
import { formatUptime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const web = buildHealth("web", process.uptime());
  const api = await fetchApiHealth(process.env.NEXT_PUBLIC_API_URL);

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
          {api.reachable
            ? `${api.data.status} (${formatUptime(api.data.uptimeSeconds)})`
            : `unreachable: ${api.reason}`}
        </li>
      </ul>
    </main>
  );
}
