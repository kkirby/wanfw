import { NextResponse } from "next/server";
import { getFrameworkStatus } from "../../../lib/orch";

// Proxies the status socket for client-side polling (route handlers run
// server-side in Next.js; this never exposes the socket itself to the browser).
export async function GET() {
  try {
    const res = await getFrameworkStatus();
    return NextResponse.json(res.body, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
