import { describe, expect, test } from "bun:test";
import * as fs from "fs";

const profilesSource = fs.readFileSync("convex/social/profiles.ts", "utf-8");
const relationshipsSource = fs.readFileSync("convex/social/relationships.ts", "utf-8");
const roomsSource = fs.readFileSync("convex/social/rooms.ts", "utf-8");
const messagesSource = fs.readFileSync("convex/social/messages.ts", "utf-8");
const sessionsSource = fs.readFileSync("convex/social/sessions.ts", "utf-8");
const authSource = fs.readFileSync("convex/auth.ts", "utf-8");

describe("social module structure", () => {
  test("auth exports connected-account helpers", () => {
    expect(authSource).toContain("export const requireConnectedUserIdentity");
    expect(authSource).toContain("export const requireConnectedUserId");
  });

  test("profiles exports profile lifecycle functions", () => {
    expect(profilesSource).toContain("export const ensureProfile =");
    expect(profilesSource).toContain("export const getMyProfile =");
    expect(profilesSource).toContain("export const updateMyProfile =");
  });

  test("relationships exports friend management functions", () => {
    expect(relationshipsSource).toContain("export const listFriends =");
    expect(relationshipsSource).toContain("export const listPendingRequests =");
    expect(relationshipsSource).toContain("export const sendFriendRequest =");
    expect(relationshipsSource).toContain("export const respondToFriendRequest =");
  });

  test("rooms exports room management functions", () => {
    expect(roomsSource).toContain("export const getOrCreateDmRoom =");
    expect(roomsSource).toContain("export const createGroupRoom =");
    expect(roomsSource).toContain("export const addGroupMembers =");
    expect(roomsSource).toContain("export const markRoomRead =");
  });

  test("messages exports room messaging functions", () => {
    expect(messagesSource).toContain("export const listRoomMessages =");
    expect(messagesSource).toContain("export const sendRoomMessage =");
  });

  test("sessions exports collaboration functions", () => {
    expect(sessionsSource).toContain("export const listSessions =");
    expect(sessionsSource).toContain("export const getSession =");
    expect(sessionsSource).toContain("export const createSession =");
    expect(sessionsSource).toContain("export const updateSessionStatus =");
    expect(sessionsSource).toContain("export const listTurns =");
    expect(sessionsSource).toContain("export const queueTurn =");
    expect(sessionsSource).toContain("export const listPendingTurnsForHostDevice =");
    expect(sessionsSource).toContain("export const claimTurn =");
    expect(sessionsSource).toContain("export const completeTurn =");
    expect(sessionsSource).toContain("export const failTurn =");
    expect(sessionsSource).toContain("export const releaseTurn =");
    expect(sessionsSource).toContain("export const listWorkspaceFiles =");
    expect(sessionsSource).toContain("export const uploadFile =");
    expect(sessionsSource).toContain("export const listFileOps =");
    expect(sessionsSource).toContain("export const acknowledgeFileOps =");
    expect(sessionsSource).toContain("export const deleteFile =");
  });
});
