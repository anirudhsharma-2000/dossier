import { NextResponse } from "next/server";

import { getJob, isFinished, subscribeJob, type JobView } from "@/lib/jobs/runner";
import { route } from "@/lib/route";
import { isServerless, SERVERLESS_MAX_SECONDS } from "@/lib/serverless";

/** Keeps proxies from closing a quiet stream while a local model thinks. */
const HEARTBEAT_MS = 15_000;
/**
 * On Vercel the job may run in another instance, whose changes this one
 * never hears: the stream reads the job this often instead, and ends before
 * the function's time is up (the page then asks now and then).
 */
const POLL_MS = 1_500;
const SERVERLESS_STREAM_MS = (SERVERLESS_MAX_SECONDS - 20) * 1000;

/**
 * A job's progress as Server-Sent Events (E6-7): its state now, then after
 * every change, until it's done or failed.
 */
export const GET = route<RouteContext<"/api/jobs/[id]/events">>(async (request, { params }) => {
  const { id } = await params;
  if (!(await getJob(id))) return NextResponse.json({ error: "That job doesn't exist." }, { status: 404 });
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let last = "";
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": still working\n\n")), HEARTBEAT_MS);
      const serverless = isServerless();
      const poll = serverless ? setInterval(() => void getJob(id).then((job) => (job ? send(job) : stop())).catch(() => {}), POLL_MS) : undefined;
      const deadline = serverless ? setTimeout(() => stop(), SERVERLESS_STREAM_MS) : undefined;
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(poll);
        clearTimeout(deadline);
        unsubscribe();
        controller.close();
      };
      const send = (job: JobView) => {
        if (closed) return;
        // Polling reads the same state again and again: only changes are sent.
        const data = JSON.stringify(job);
        if (data === last) return;
        last = data;
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        if (isFinished(job)) stop();
      };
      // Listen before reading, so a change in between isn't missed.
      const unsubscribe = subscribeJob(id, send);
      request.signal.addEventListener("abort", () => stop(), { once: true });
      const job = await getJob(id);
      if (job) send(job);
      else stop();
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Tells nginx (CapRover) not to buffer the stream.
      "x-accel-buffering": "no",
    },
  });
});
