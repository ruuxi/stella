import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type {
  MessagesNotesSignals,
  ContactFrequency,
  GroupChat,
  NoteFolder,
  CalendarSummary,
} from "./discovery_types.js";

const log = (...args: unknown[]) => console.log("[messages-notes]", ...args);

// Timeout wrapper
const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

// SQLite helper
declare const globalThis: typeof global & { Bun?: unknown };
type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};
const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  if (typeof globalThis.Bun !== "undefined") {
    // @ts-expect-error bun:sqlite only available at runtime in Bun
    const { Database: BunDatabase } = await import("bun:sqlite");
    return new BunDatabase(dbPath, { readonly: true }) as SqliteDatabase;
  }
  const { default: Database } = await import("better-sqlite3");
  return new Database(dbPath, { readonly: true }) as SqliteDatabase;
};

/**
 * Collect iMessage metadata (contacts and group chats)
 * macOS only - requires Full Disk Access
 */
async function collectIMessageMetadata(
  stellaHome: string
): Promise<{ contacts: ContactFrequency[]; groupChats: GroupChat[] }> {
  if (process.platform !== "darwin") {
    return { contacts: [], groupChats: [] };
  }

  const sourceDb = path.join(os.homedir(), "Library/Messages/chat.db");
  const cacheDir = path.join(stellaHome, "cache");
  const cachedDb = path.join(cacheDir, "messages.db");

  try {
    // Ensure cache directory exists
    await fs.mkdir(cacheDir, { recursive: true });

    // Copy database to cache
    await fs.copyFile(sourceDb, cachedDb);

    // Open database
    const db = await openDatabase(cachedDb);

    try {
      // Query contact frequency (NO message body - only handle + count)
      const contactQuery = `
        SELECT
          h.id as identifier,
          COALESCE(h.uncanonicalized_id, h.id) as display_name,
          COUNT(*) as msg_count
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.handle_id IS NOT NULL
          AND m.date > (
            (strftime('%s', '2001-01-01') + strftime('%s', 'now') - 2592000)
            * 1000000000
          )
        GROUP BY h.id, h.uncanonicalized_id
        ORDER BY msg_count DESC
        LIMIT 30
      `;
      const contactRows = db.prepare(contactQuery).all() as Array<{
        identifier: string;
        display_name: string;
        msg_count: number;
      }>;

      const contacts: ContactFrequency[] = contactRows.map((row) => ({
        identifier: row.identifier,
        displayName: row.display_name,
        messageCount: row.msg_count,
      }));

      // Query group chats
      const groupQuery = `
        SELECT
          c.display_name as name,
          (SELECT COUNT(DISTINCT chj.handle_id) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) as participant_count
        FROM chat c
        WHERE c.display_name IS NOT NULL
          AND c.display_name != ''
          AND c.style = 43
      `;
      const groupRows = db.prepare(groupQuery).all() as Array<{
        name: string;
        participant_count: number;
      }>;

      const groupChats: GroupChat[] = groupRows.map((row) => ({
        name: row.name,
        participantCount: row.participant_count,
      }));

      log(`Collected ${contacts.length} contacts, ${groupChats.length} group chats`);

      return { contacts, groupChats };
    } finally {
      db.close();
      // Delete cached copy
      await fs.unlink(cachedDb).catch(() => {});
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
      log("Messages access denied - grant Full Disk Access");
    } else {
      log("Error collecting iMessage metadata:", error);
    }
    // Clean up cache on error
    await fs.unlink(cachedDb).catch(() => {});
    return { contacts: [], groupChats: [] };
  }
}

/**
 * Collect Apple Notes metadata (folders and counts)
 * macOS only - requires Full Disk Access
 */
async function collectAppleNotes(stellaHome: string): Promise<NoteFolder[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  const sourceDb = path.join(
    os.homedir(),
    "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
  );
  const cacheDir = path.join(stellaHome, "cache");
  const cachedDb = path.join(cacheDir, "notes.db");

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.copyFile(sourceDb, cachedDb);

    const db = await openDatabase(cachedDb);

    try {
      // Try primary query first
      let query = `
        SELECT
          COALESCE(folder.ZTITLE2, 'Uncategorized') as folder_name,
          COUNT(*) as note_count
        FROM ZICCLOUDSYNCINGOBJECT note
        LEFT JOIN ZICCLOUDSYNCINGOBJECT folder ON note.ZFOLDER = folder.Z_PK AND folder.ZTITLE2 IS NOT NULL
        WHERE note.ZTITLE1 IS NOT NULL
          AND note.ZMARKEDFORDELETION != 1
        GROUP BY folder_name
        ORDER BY note_count DESC
      `;

      let rows: Array<{ folder_name: string; note_count: number }>;

      try {
        rows = db.prepare(query).all() as Array<{ folder_name: string; note_count: number }>;
      } catch {
        // Try fallback with alternative column names
        log("Primary Notes query failed, trying fallback");
        query = `
          SELECT
            COALESCE(folder.ZTITLE, 'Uncategorized') as folder_name,
            COUNT(*) as note_count
          FROM ZICCLOUDSYNCINGOBJECT note
          LEFT JOIN ZICCLOUDSYNCINGOBJECT folder ON note.ZFOLDER = folder.Z_PK AND folder.ZTITLE IS NOT NULL
          WHERE note.ZTITLE IS NOT NULL
            AND note.ZMARKEDFORDELETION != 1
          GROUP BY folder_name
          ORDER BY note_count DESC
        `;

        try {
          rows = db.prepare(query).all() as Array<{ folder_name: string; note_count: number }>;
        } catch {
          // Final fallback - just count notes
          log("Alternative Notes query failed, using simple fallback");
          query = `
            SELECT 'Notes' as folder_name, COUNT(*) as note_count
            FROM ZICCLOUDSYNCINGOBJECT
            WHERE ZTYPEUTI = 'com.apple.notes.note'
          `;
          rows = db.prepare(query).all() as Array<{ folder_name: string; note_count: number }>;
        }
      }

      const folders: NoteFolder[] = rows.map((row) => ({
        name: row.folder_name,
        noteCount: row.note_count,
      }));

      log(`Collected ${folders.length} note folders`);

      return folders;
    } finally {
      db.close();
      await fs.unlink(cachedDb).catch(() => {});
    }
  } catch (error) {
    log("Error collecting Apple Notes:", error);
    await fs.unlink(cachedDb).catch(() => {});
    return [];
  }
}

/**
 * Collect Reminders metadata
 * macOS only
 */
async function collectReminders(stellaHome: string): Promise<NoteFolder[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  // Try multiple possible locations
  const possiblePaths = [
    path.join(os.homedir(), "Library/Reminders/Container_v1/Stores"),
    path.join(
      os.homedir(),
      "Library/Group Containers/group.com.apple.reminders/Container_v1/Stores"
    ),
  ];

  let sourceDb: string | null = null;

  for (const basePath of possiblePaths) {
    try {
      const files = await fs.readdir(basePath);
      const sqliteFile = files.find((f) => f.endsWith(".sqlite"));
      if (sqliteFile) {
        sourceDb = path.join(basePath, sqliteFile);
        break;
      }
    } catch {
      continue;
    }
  }

  if (!sourceDb) {
    log("Reminders database not found");
    return [];
  }

  const cacheDir = path.join(stellaHome, "cache");
  const cachedDb = path.join(cacheDir, "reminders.db");

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.copyFile(sourceDb, cachedDb);

    const db = await openDatabase(cachedDb);

    try {
      const query = `
        SELECT
          ZTITLE as name,
          (SELECT COUNT(*) FROM ZREMCDREMINDER r WHERE r.ZLIST = l.Z_PK) as note_count
        FROM ZREMCDLIST l
        WHERE ZTITLE IS NOT NULL
        ORDER BY note_count DESC
      `;

      const rows = db.prepare(query).all() as Array<{ name: string; note_count: number }>;

      const reminders: NoteFolder[] = rows.map((row) => ({
        name: row.name,
        noteCount: row.note_count,
      }));

      log(`Collected ${reminders.length} reminder lists`);

      return reminders;
    } finally {
      db.close();
      await fs.unlink(cachedDb).catch(() => {});
    }
  } catch (error) {
    log("Error collecting Reminders:", error);
    await fs.unlink(cachedDb).catch(() => {});
    return [];
  }
}

/**
 * Collect Calendar metadata
 * macOS only - requires Full Disk Access
 */
async function collectCalendar(stellaHome: string): Promise<CalendarSummary[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  const sourceDb = path.join(os.homedir(), "Library/Calendars/Calendar.sqlitedb");
  const cacheDir = path.join(stellaHome, "cache");
  const cachedDb = path.join(cacheDir, "calendar.db");

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.copyFile(sourceDb, cachedDb);

    const db = await openDatabase(cachedDb);

    try {
      // Query for calendar names and event counts
      const calendarQuery = `
        SELECT
          c.ZTITLE as calendar_name,
          COUNT(e.Z_PK) as event_count
        FROM ZCALENDAR c
        LEFT JOIN ZCALENDARITEM e ON e.ZCALENDAR = c.Z_PK
        WHERE c.ZTITLE IS NOT NULL
        GROUP BY c.Z_PK
        ORDER BY event_count DESC
      `;
      const calendarRows = db.prepare(calendarQuery).all() as Array<{
        calendar_name: string;
        event_count: number;
      }>;

      // Query for recurring event titles (high signal — reveals habits)
      const recurringQuery = `
        SELECT DISTINCT ci.ZTITLE as title, c.ZTITLE as calendar_name
        FROM ZCALENDARITEM ci
        JOIN ZCALENDAR c ON ci.ZCALENDAR = c.Z_PK
        WHERE ci.ZRECURRENCERULE IS NOT NULL
          AND ci.ZTITLE IS NOT NULL
          AND ci.ZTITLE != ''
        LIMIT 20
      `;
      const recurringRows = db.prepare(recurringQuery).all() as Array<{
        title: string;
        calendar_name: string;
      }>;

      // Build calendar summaries
      const calendars: CalendarSummary[] = calendarRows.map((row) => {
        const recurringTitles = recurringRows
          .filter((r) => r.calendar_name === row.calendar_name)
          .map((r) => r.title);

        return {
          calendarName: row.calendar_name,
          eventCount: row.event_count,
          recurringTitles,
        };
      });

      log(`Collected ${calendars.length} calendars`);

      return calendars;
    } finally {
      db.close();
      await fs.unlink(cachedDb).catch(() => {});
    }
  } catch (error) {
    log("Error collecting Calendar:", error);
    await fs.unlink(cachedDb).catch(() => {});
    return [];
  }
}

/**
 * Collect Windows Sticky Notes metadata
 * Windows only
 */
async function collectStickyNotes(stellaHome: string): Promise<NoteFolder[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    log("LOCALAPPDATA not found");
    return [];
  }

  const packagesDir = path.join(localAppData, "Packages");

  try {
    const packages = await fs.readdir(packagesDir);
    const stickyNotesDir = packages.find((p) => p.startsWith("Microsoft.MicrosoftStickyNotes_"));

    if (!stickyNotesDir) {
      log("Sticky Notes package not found");
      return [];
    }

    const sourceDb = path.join(packagesDir, stickyNotesDir, "LocalState/plum.sqlite");
    const cacheDir = path.join(stellaHome, "cache");
    const cachedDb = path.join(cacheDir, "stickynotes.db");

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.copyFile(sourceDb, cachedDb);

    const db = await openDatabase(cachedDb);

    try {
      // Try primary query first
      let query = `SELECT 'Sticky Notes' as name, COUNT(*) as note_count FROM Note WHERE IsDeleted = 0`;
      let rows: Array<{ name: string; note_count: number }>;

      try {
        rows = db.prepare(query).all() as Array<{ name: string; note_count: number }>;
      } catch {
        // Fallback if schema is different
        query = `SELECT 'Sticky Notes' as name, COUNT(*) as note_count FROM Note`;
        rows = db.prepare(query).all() as Array<{ name: string; note_count: number }>;
      }

      const notes: NoteFolder[] = rows.map((row) => ({
        name: row.name,
        noteCount: row.note_count,
      }));

      log(`Collected ${notes.length} sticky note folders`);

      return notes;
    } finally {
      db.close();
      await fs.unlink(cachedDb).catch(() => {});
    }
  } catch (error) {
    log("Error collecting Sticky Notes:", error);
    return [];
  }
}

/**
 * Main collection function
 */
export async function collectMessagesNotes(stellaHome: string): Promise<MessagesNotesSignals> {
  const platform = process.platform;

  if (platform === "darwin") {
    const [imsg, notes, reminders, calendars] = await Promise.all([
      withTimeout(collectIMessageMetadata(stellaHome), 10000, { contacts: [], groupChats: [] }),
      withTimeout(collectAppleNotes(stellaHome), 5000, []),
      withTimeout(collectReminders(stellaHome), 5000, []),
      withTimeout(collectCalendar(stellaHome), 5000, []),
    ]);
    return {
      contacts: imsg.contacts,
      groupChats: imsg.groupChats,
      noteFolders: [...notes, ...reminders],
      calendars,
    };
  }

  if (platform === "win32") {
    const stickyNotes = await withTimeout(collectStickyNotes(stellaHome), 5000, []);
    return { contacts: [], groupChats: [], noteFolders: stickyNotes, calendars: [] };
  }

  return { contacts: [], groupChats: [], noteFolders: [], calendars: [] };
}

/**
 * Format messages and notes signals for synthesis
 */
export function formatMessagesNotesForSynthesis(data: MessagesNotesSignals): string {
  const sections: string[] = [];

  // Communication Patterns
  if (data.contacts.length > 0) {
    const contactLines = data.contacts.map(
      (c) => `- ${c.displayName} (${c.messageCount} messages)`
    );
    sections.push(`### Communication Patterns\nTop contacts by message frequency:\n${contactLines.join("\n")}`);
  }

  // Group Chats
  if (data.groupChats.length > 0) {
    const groupLines = data.groupChats.map((g) => `- ${g.name} (${g.participantCount} members)`);
    sections.push(`### Group Chats\n${groupLines.join("\n")}`);
  }

  // Note Organization
  if (data.noteFolders.length > 0) {
    const folderLines = data.noteFolders.map((f) => `- ${f.name}: ${f.noteCount} notes`);
    sections.push(`### Note Organization\n${folderLines.join("\n")}`);
  }

  // Calendars
  if (data.calendars.length > 0) {
    const calendarLines = data.calendars.map((cal) => {
      let line = `- ${cal.calendarName}: ${cal.eventCount} events`;
      if (cal.recurringTitles.length > 0) {
        line += `\n  Recurring: ${cal.recurringTitles.join(", ")}`;
      }
      return line;
    });
    sections.push(`### Calendars\n${calendarLines.join("\n")}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `## Messages & Notes (metadata only)\n${sections.join("\n\n")}`;
}
