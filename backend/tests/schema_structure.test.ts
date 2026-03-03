import { describe, test, expect } from "bun:test";
import { agentsSchema } from "../convex/schema/agents";
import { authSchema } from "../convex/schema/auth";
import { conversationsSchema } from "../convex/schema/conversations";
import { devicesSchema } from "../convex/schema/devices";
import { integrationsSchema } from "../convex/schema/integrations";
import { schedulingSchema } from "../convex/schema/scheduling";
import { telemetrySchema } from "../convex/schema/telemetry";
import { usersSchema } from "../convex/schema/users";
import { cronScheduleValidator, cronPayloadValidator } from "../convex/schema/scheduling";

describe("schema modules export table definitions", () => {
  test("agentsSchema is a non-empty object", () => {
    expect(typeof agentsSchema).toBe("object");
    expect(Object.keys(agentsSchema).length).toBeGreaterThan(0);
  });

  test("authSchema is a non-empty object", () => {
    expect(typeof authSchema).toBe("object");
    expect(Object.keys(authSchema).length).toBeGreaterThan(0);
  });

  test("conversationsSchema is a non-empty object", () => {
    expect(typeof conversationsSchema).toBe("object");
    expect(Object.keys(conversationsSchema).length).toBeGreaterThan(0);
  });

  test("devicesSchema is a non-empty object", () => {
    expect(typeof devicesSchema).toBe("object");
    expect(Object.keys(devicesSchema).length).toBeGreaterThan(0);
  });

  test("integrationsSchema is a non-empty object", () => {
    expect(typeof integrationsSchema).toBe("object");
    expect(Object.keys(integrationsSchema).length).toBeGreaterThan(0);
  });

  test("schedulingSchema is a non-empty object", () => {
    expect(typeof schedulingSchema).toBe("object");
    expect(Object.keys(schedulingSchema).length).toBeGreaterThan(0);
  });

  test("telemetrySchema is a non-empty object", () => {
    expect(typeof telemetrySchema).toBe("object");
    expect(Object.keys(telemetrySchema).length).toBeGreaterThan(0);
  });

  test("usersSchema is a non-empty object", () => {
    expect(typeof usersSchema).toBe("object");
    expect(Object.keys(usersSchema).length).toBeGreaterThan(0);
  });
});

describe("scheduling validators", () => {
  test("cronScheduleValidator is defined", () => {
    expect(cronScheduleValidator).toBeDefined();
  });

  test("cronPayloadValidator is defined", () => {
    expect(cronPayloadValidator).toBeDefined();
  });
});
