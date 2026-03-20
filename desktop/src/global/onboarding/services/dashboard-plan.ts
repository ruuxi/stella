/**
 * Calls the backend to turn CORE_MEMORY into three dashboard page assignments (LLM).
 * Prompts are owned by the backend — the client only sends the user's core memory.
 */

import { createServiceRequest } from "@/infra/http/service-request";

export type PlannedDashboardPage = {
  pageId: string;
  title: string;
  topic: string;
  focus: string;
  dataSources: string[];
  personalOrEntertainment: boolean;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const parsePlannedDashboardPage = (
  value: unknown,
  index: number,
): PlannedDashboardPage => {
  assert(
    typeof value === "object" && value !== null,
    `Dashboard plan page ${index + 1} must be an object`,
  );

  const page = value as Record<string, unknown>;
  assert(typeof page.pageId === "string" && page.pageId.trim(), "Dashboard plan pageId is required");
  assert(typeof page.title === "string" && page.title.trim(), "Dashboard plan title is required");
  assert(typeof page.topic === "string" && page.topic.trim(), "Dashboard plan topic is required");
  assert(typeof page.focus === "string" && page.focus.trim(), "Dashboard plan focus is required");
  assert(
    typeof page.personalOrEntertainment === "boolean",
    "Dashboard plan personalOrEntertainment must be a boolean",
  );
  assert(Array.isArray(page.dataSources), "Dashboard plan dataSources must be an array");

  return {
    pageId: page.pageId.trim(),
    title: page.title.trim(),
    topic: page.topic.trim(),
    focus: page.focus.trim(),
    dataSources: page.dataSources.map((value) => {
      assert(typeof value === "string" && value.trim(), "Dashboard plan dataSources must contain strings");
      return value.trim();
    }),
    personalOrEntertainment: page.personalOrEntertainment,
  };
};

export async function planDashboardPages(
  coreMemory: string,
  includeAuth: boolean,
): Promise<PlannedDashboardPage[]> {
  const { endpoint, headers } = await createServiceRequest(
    "/api/plan-dashboard-pages",
    {
      "Content-Type": "application/json",
    },
    {
      includeAuth,
    },
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ coreMemory }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dashboard plan failed: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as { pages?: unknown };
  assert(Array.isArray(data.pages), "Dashboard plan returned invalid pages");
  assert(data.pages.length === 3, `Dashboard plan returned ${data.pages.length} pages`);

  return data.pages.map(parsePlannedDashboardPage);
}
