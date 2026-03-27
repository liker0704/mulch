import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerEditCommand } from "../../src/commands/edit.ts";
import { DEFAULT_CONFIG } from "../../src/schemas/config.ts";
import {
  getExpertisePath,
  initMulchDir,
  writeConfig,
} from "../../src/utils/config.ts";
import {
  appendRecord,
  createExpertiseFile,
  readExpertiseFile,
} from "../../src/utils/expertise.ts";

describe("edit command", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mulch-edit-test-"));
    await initMulchDir(tmpDir);
    await writeConfig({ ...DEFAULT_CONFIG, domains: ["testing"] }, tmpDir);
    const filePath = getExpertisePath("testing", tmpDir);
    await createExpertiseFile(filePath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("updates a convention record's content", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "convention",
      content: "Old content",
      classification: "foundational",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = { ...records[0] };
    if (record.type === "convention") {
      record.content = "New content";
    }
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    expect(updated).toHaveLength(1);
    expect(updated[0].type).toBe("convention");
    if (updated[0].type === "convention") {
      expect(updated[0].content).toBe("New content");
    }
  });

  it("updates a pattern record's description", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "pattern",
      name: "Test Pattern",
      description: "Old description",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = { ...records[0] };
    if (record.type === "pattern") {
      record.description = "Updated description";
    }
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].type).toBe("pattern");
    if (updated[0].type === "pattern") {
      expect(updated[0].description).toBe("Updated description");
      expect(updated[0].name).toBe("Test Pattern");
    }
  });

  it("updates classification without changing other fields", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "convention",
      content: "Keep this content",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = { ...records[0], classification: "foundational" as const };
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].classification).toBe("foundational");
    if (updated[0].type === "convention") {
      expect(updated[0].content).toBe("Keep this content");
    }
  });

  it("updates a failure record's resolution", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "failure",
      description: "Something broke",
      resolution: "Old fix",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = { ...records[0] };
    if (record.type === "failure") {
      record.resolution = "Better fix";
    }
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    if (updated[0].type === "failure") {
      expect(updated[0].resolution).toBe("Better fix");
      expect(updated[0].description).toBe("Something broke");
    }
  });

  it("updates a decision record's rationale", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "decision",
      title: "Use ESM",
      rationale: "Old rationale",
      classification: "foundational",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = { ...records[0] };
    if (record.type === "decision") {
      record.rationale = "Better tree-shaking and modern standards";
    }
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    if (updated[0].type === "decision") {
      expect(updated[0].rationale).toBe(
        "Better tree-shaking and modern standards",
      );
      expect(updated[0].title).toBe("Use ESM");
    }
  });

  it("preserves other records when editing one", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "convention",
      content: "First record",
      classification: "foundational",
      recorded_at: new Date().toISOString(),
    });
    await appendRecord(filePath, {
      type: "convention",
      content: "Second record",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });
    await appendRecord(filePath, {
      type: "convention",
      content: "Third record",
      classification: "observational",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    expect(records).toHaveLength(3);

    // Edit only the second record
    const record = { ...records[1] };
    if (record.type === "convention") {
      record.content = "Updated second record";
    }
    records[1] = record;

    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, records);

    const updated = await readExpertiseFile(filePath);
    expect(updated).toHaveLength(3);
    if (updated[0].type === "convention") {
      expect(updated[0].content).toBe("First record");
    }
    if (updated[1].type === "convention") {
      expect(updated[1].content).toBe("Updated second record");
    }
    if (updated[2].type === "convention") {
      expect(updated[2].content).toBe("Third record");
    }
  });

  it("updates pattern files list", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "pattern",
      name: "Test Pattern",
      description: "A pattern",
      files: ["old.ts"],
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = { ...records[0] };
    if (record.type === "pattern") {
      record.files = ["new.ts", "other.ts"];
    }
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    if (updated[0].type === "pattern") {
      expect(updated[0].files).toEqual(["new.ts", "other.ts"]);
    }
  });

  it("adds outcomes to a record without one", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "convention",
      content: "Some convention",
      classification: "foundational",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = {
      ...records[0],
      outcomes: [{ status: "success" as const, duration: 1200 }],
    };
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].outcomes?.[0]?.status).toBe("success");
    expect(updated[0].outcomes?.[0]?.duration).toBe(1200);
  });

  it("appends outcome to an existing record's outcomes array", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "failure",
      description: "Build broke",
      resolution: "Fixed config",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
      outcomes: [{ status: "failure", agent: "build-agent" }],
    });

    const records = await readExpertiseFile(filePath);
    const record = {
      ...records[0],
      outcomes: [
        ...(records[0].outcomes ?? []),
        {
          status: "success" as const,
          agent: "build-agent",
          test_results: "Resolved",
        },
      ],
    };
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].outcomes).toHaveLength(2);
    expect(updated[0].outcomes?.[1]?.status).toBe("success");
    expect(updated[0].outcomes?.[1]?.agent).toBe("build-agent");
    expect(updated[0].outcomes?.[1]?.test_results).toBe("Resolved");
  });

  it("preserves other record fields when adding outcomes", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "decision",
      title: "Use TypeScript",
      rationale: "Type safety",
      classification: "foundational",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const record = {
      ...records[0],
      outcomes: [{ status: "success" as const }],
    };
    const { writeExpertiseFile } = await import("../../src/utils/expertise.js");
    await writeExpertiseFile(filePath, [record]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].type).toBe("decision");
    if (updated[0].type === "decision") {
      expect(updated[0].title).toBe("Use TypeScript");
      expect(updated[0].rationale).toBe("Type safety");
    }
    expect(updated[0].outcomes?.[0]?.status).toBe("success");
  });
});

// ── CLI flags: --audience, --context, --consequences, --decision-status, --related-files, --related-mission ──

async function runEdit(
  tmpDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const logSpy = spyOn(console, "log").mockImplementation((...a) => {
    stdoutLines.push(a.map(String).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...a) => {
    stderrLines.push(a.map(String).join(" "));
  });
  const warnSpy = spyOn(console, "warn").mockImplementation((...a) => {
    stderrLines.push(a.map(String).join(" "));
  });

  const prevExitCode = process.exitCode;
  process.exitCode = 0;

  const origCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const program = new Command();
    program.option("--json", "output JSON");
    program.exitOverride();
    registerEditCommand(program);
    await program.parseAsync(["node", "mulch", "edit", ...args]);
  } catch {
    // ignore commander exitOverride
  } finally {
    process.chdir(origCwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  }

  const exitCode = process.exitCode as number | undefined;
  process.exitCode = prevExitCode;

  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
    exitCode,
  };
}

describe("edit command -- new field flags", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mulch-edit-flags-test-"));
    await initMulchDir(tmpDir);
    await writeConfig({ ...DEFAULT_CONFIG, domains: ["testing"] }, tmpDir);
    const filePath = getExpertisePath("testing", tmpDir);
    await createExpertiseFile(filePath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("--audience sets audience on convention record", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "convention",
      content: "Old content",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const id = records[0].id as string;

    await runEdit(tmpDir, ["testing", id, "--audience", "human"]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].audience).toBe("human");
  });

  it("decision-only flags set fields on decision record", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "decision",
      title: "Use PostgreSQL",
      rationale: "Better scalability",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const id = records[0].id as string;

    await runEdit(tmpDir, [
      "testing",
      id,
      "--audience",
      "engineers",
      "--context",
      "We needed a scalable DB",
      "--consequences",
      "Migration required",
      "--decision-status",
      "accepted",
      "--related-files",
      "src/db.ts,src/config.ts",
      "--related-mission",
      "infrastructure",
    ]);

    const updated = await readExpertiseFile(filePath);
    expect(updated[0].type).toBe("decision");
    if (updated[0].type === "decision") {
      expect(updated[0].audience).toBe("engineers");
      expect(updated[0].context).toBe("We needed a scalable DB");
      expect(updated[0].consequences).toBe("Migration required");
      expect(updated[0].decision_status).toBe("accepted");
      expect(updated[0].related_files).toEqual(["src/db.ts", "src/config.ts"]);
      expect(updated[0].related_mission).toBe("infrastructure");
    }
  });

  it("decision-only flags warn and are ignored for non-decision types", async () => {
    const filePath = getExpertisePath("testing", tmpDir);
    await appendRecord(filePath, {
      type: "convention",
      content: "Some convention",
      classification: "tactical",
      recorded_at: new Date().toISOString(),
    });

    const records = await readExpertiseFile(filePath);
    const id = records[0].id as string;

    const { stderr } = await runEdit(tmpDir, [
      "testing",
      id,
      "--context",
      "foo",
    ]);

    const updated = await readExpertiseFile(filePath);
    // context should NOT be set on convention record
    expect((updated[0] as Record<string, unknown>).context).toBeUndefined();
    // warning should appear
    expect(stderr).toContain("--context");
    expect(stderr).toContain("ignored");
  });
});
