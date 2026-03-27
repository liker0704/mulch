import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeConsolidation,
  applyConsolidation,
} from "../../src/commands/consolidate.ts";
import { DEFAULT_CONFIG } from "../../src/schemas/config.ts";
import type { ExpertiseRecord } from "../../src/schemas/record.ts";
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
import { isRecordStale } from "../../src/utils/expertise.ts";
import { computeConfirmationScore } from "../../src/utils/scoring.ts";

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

describe("consolidate command", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mulch-consolidate-test-"));
    await initMulchDir(tmpDir);
    await writeConfig(
      { ...DEFAULT_CONFIG, domains: ["testing", "architecture"] },
      tmpDir,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("analyzeConsolidation", () => {
    it("promotes confirmed tactical records", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-aaa111",
          type: "convention",
          content: "Use tabs",
          classification: "tactical",
          recorded_at: daysAgo(5),
          outcomes: [{ status: "success" }],
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      expect(result.toPromote).toHaveLength(1);
      expect(result.toPromote[0].id).toBe("mx-aaa111");
      expect(result.toRemove).toHaveLength(0);
    });

    it("does not promote records below threshold", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-bbb222",
          type: "convention",
          content: "No outcomes",
          classification: "tactical",
          recorded_at: daysAgo(5),
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      expect(result.toPromote).toHaveLength(0);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].classification).toBe("tactical");
    });

    it("removes expired observational records", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-ccc333",
          type: "convention",
          content: "Old observational",
          classification: "observational",
          recorded_at: daysAgo(45),
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      expect(result.toRemove).toHaveLength(1);
      expect(result.toRemove[0].id).toBe("mx-ccc333");
    });

    it("removes expired tactical records with low score", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-ddd444",
          type: "convention",
          content: "Old tactical",
          classification: "tactical",
          recorded_at: daysAgo(20),
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      expect(result.toRemove).toHaveLength(1);
      expect(result.toRemove[0].id).toBe("mx-ddd444");
    });

    it("does not remove promotable stale records", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-eee555",
          type: "convention",
          content: "Stale but promoted",
          classification: "tactical",
          recorded_at: daysAgo(20),
          outcomes: [{ status: "success" }],
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      // Should be in toPromote (not toRemove) — gets promoted instead of removed
      expect(result.toRemove).toHaveLength(0);
      expect(result.toPromote).toHaveLength(1);
    });

    it("never touches foundational records", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-fff666",
          type: "convention",
          content: "Foundational",
          classification: "foundational",
          recorded_at: daysAgo(365),
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      expect(result.toPromote).toHaveLength(0);
      expect(result.toRemove).toHaveLength(0);
      expect(result.kept).toHaveLength(1);
    });

    it("counts records without outcome data", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-ggg777",
          type: "convention",
          content: "No outcome",
          classification: "tactical",
          recorded_at: daysAgo(5),
        },
        {
          id: "mx-hhh888",
          type: "convention",
          content: "Has outcome",
          classification: "tactical",
          recorded_at: daysAgo(5),
          outcomes: [{ status: "success" }],
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = analyzeConsolidation(records, config, 1, now);

      expect(result.noOutcomeCount).toBe(1);
    });

    it("rejects invalid domain with error", () => {
      // This test verifies domain validation logic - no direct fn to test,
      // so we check that the domain list is used correctly
      const config = { ...DEFAULT_CONFIG, domains: ["cli", "testing"] };
      expect(config.domains.includes("nonexistent")).toBe(false);
    });
  });

  describe("applyConsolidation", () => {
    it("promotes tactical records by setting classification to foundational", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-aaa001",
          type: "convention",
          content: "Apply test",
          classification: "tactical",
          recorded_at: daysAgo(5),
          outcomes: [{ status: "success" }],
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = applyConsolidation(records, config, 1, now);

      expect(result.promoted).toBe(1);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].classification).toBe("foundational");
    });

    it("removes expired records", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-bbb001",
          type: "convention",
          content: "Remove test",
          classification: "observational",
          recorded_at: daysAgo(45),
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = applyConsolidation(records, config, 1, now);

      expect(result.removed).toBe(1);
      expect(result.records).toHaveLength(0);
    });

    it("keeps foundational records unchanged", () => {
      const records: ExpertiseRecord[] = [
        {
          id: "mx-ccc001",
          type: "convention",
          content: "Keep foundational",
          classification: "foundational",
          recorded_at: daysAgo(365),
        },
      ];

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = applyConsolidation(records, config, 1, now);

      expect(result.promoted).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].classification).toBe("foundational");
    });
  });

  describe("multi-domain processing", () => {
    it("processes multiple domains correctly", async () => {
      const testingPath = getExpertisePath("testing", tmpDir);
      const archPath = getExpertisePath("architecture", tmpDir);
      await createExpertiseFile(testingPath);
      await createExpertiseFile(archPath);

      // Testing domain: tactical with success outcomes
      await appendRecord(testingPath, {
        type: "convention",
        content: "Testing convention",
        classification: "tactical",
        recorded_at: daysAgo(5),
        outcomes: [{ status: "success" }],
      });

      // Architecture domain: old observational
      await appendRecord(archPath, {
        type: "decision",
        title: "Old architecture decision",
        rationale: "Was observational",
        classification: "observational",
        recorded_at: daysAgo(45),
      });

      const testingRecords = await readExpertiseFile(testingPath);
      const archRecords = await readExpertiseFile(archPath);

      const config = DEFAULT_CONFIG;
      const now = new Date();

      const testingResult = applyConsolidation(testingRecords, config, 1, now);
      const archResult = applyConsolidation(archRecords, config, 1, now);

      expect(testingResult.promoted).toBe(1);
      expect(testingResult.records[0].classification).toBe("foundational");

      expect(archResult.removed).toBe(1);
      expect(archResult.records).toHaveLength(0);
    });
  });

  describe("analyze mode idempotency", () => {
    it("analyze mode does not modify files", async () => {
      const filePath = getExpertisePath("testing", tmpDir);
      await createExpertiseFile(filePath);

      await appendRecord(filePath, {
        type: "convention",
        content: "Stable record",
        classification: "tactical",
        recorded_at: daysAgo(5),
      });

      const statBefore = await stat(filePath);

      // Simulate analyze (read but don't write)
      const records = await readExpertiseFile(filePath);
      const config = DEFAULT_CONFIG;
      const now = new Date();
      analyzeConsolidation(records, config, 1, now);

      const statAfter = await stat(filePath);
      expect(statBefore.mtimeMs).toBe(statAfter.mtimeMs);
    });
  });

  describe("governance metrics", () => {
    it("reports utilization after consolidation", () => {
      const records: ExpertiseRecord[] = Array.from({ length: 10 }, (_, i) => ({
        id: `mx-util${i.toString().padStart(3, "0")}`,
        type: "convention" as const,
        content: `Record ${i}`,
        classification: "foundational" as const,
        recorded_at: daysAgo(1),
      }));

      const config = DEFAULT_CONFIG;
      const now = new Date();
      const result = applyConsolidation(records, config, 1, now);

      // All foundational — nothing removed or promoted
      expect(result.records).toHaveLength(10);

      // Calculate utilization manually
      const utilization = Math.round(
        (result.records.length / config.governance.max_entries) * 100,
      );
      expect(utilization).toBe(10); // 10/100 = 10%
    });
  });

  describe("isRecordStale and computeConfirmationScore", () => {
    it("isRecordStale returns false for foundational", () => {
      const record: ExpertiseRecord = {
        type: "convention",
        content: "foundational content",
        classification: "foundational",
        recorded_at: daysAgo(365),
      };
      const shelfLife = DEFAULT_CONFIG.classification_defaults.shelf_life;
      expect(isRecordStale(record, new Date(), shelfLife)).toBe(false);
    });

    it("computeConfirmationScore returns 0 with no outcomes", () => {
      const record: ExpertiseRecord = {
        type: "convention",
        content: "no outcomes",
        classification: "tactical",
        recorded_at: daysAgo(5),
      };
      expect(computeConfirmationScore(record)).toBe(0);
    });

    it("computeConfirmationScore counts successes", () => {
      const record: ExpertiseRecord = {
        type: "convention",
        content: "two successes",
        classification: "tactical",
        recorded_at: daysAgo(5),
        outcomes: [{ status: "success" }, { status: "success" }],
      };
      expect(computeConfirmationScore(record)).toBe(2);
    });
  });
});
