import chalk from "chalk";
import type { Command } from "commander";
import type { Classification, ExpertiseRecord } from "../schemas/record.ts";
import { getExpertisePath, readConfig } from "../utils/config.ts";
import {
  calculateDomainHealth,
  isRecordStale,
  readExpertiseFile,
  writeExpertiseFile,
} from "../utils/expertise.ts";
import { outputJson, outputJsonError } from "../utils/json-output.ts";
import { withFileLock } from "../utils/lock.ts";
import { accent, brand, isQuiet, muted } from "../utils/palette.ts";
import { computeConfirmationScore } from "../utils/scoring.ts";

interface ConsolidationAnalysis {
  toPromote: ExpertiseRecord[];
  toRemove: ExpertiseRecord[];
  kept: ExpertiseRecord[];
  noOutcomeCount: number;
}

interface ConsolidationResult {
  records: ExpertiseRecord[];
  promoted: number;
  removed: number;
}

export function analyzeConsolidation(
  records: ExpertiseRecord[],
  config: {
    classification_defaults: {
      shelf_life: { tactical: number; observational: number };
    };
  },
  minConfirmations: number,
  now: Date,
): ConsolidationAnalysis {
  const shelfLife = config.classification_defaults.shelf_life;
  const toPromote: ExpertiseRecord[] = [];
  const toRemove: ExpertiseRecord[] = [];
  const kept: ExpertiseRecord[] = [];
  let noOutcomeCount = 0;

  for (const record of records) {
    if (!record.outcomes || record.outcomes.length === 0) {
      noOutcomeCount++;
    }

    const score = computeConfirmationScore(record);
    const stale = isRecordStale(record, now, shelfLife);

    if (record.classification === "tactical" && score >= minConfirmations) {
      toPromote.push(record);
      kept.push(record);
    } else if (stale && score < minConfirmations) {
      toRemove.push(record);
    } else {
      kept.push(record);
    }
  }

  return { toPromote, toRemove, kept, noOutcomeCount };
}

export function applyConsolidation(
  records: ExpertiseRecord[],
  config: {
    classification_defaults: {
      shelf_life: { tactical: number; observational: number };
    };
  },
  minConfirmations: number,
  now: Date,
): ConsolidationResult {
  const { toPromote, toRemove } = analyzeConsolidation(
    records,
    config,
    minConfirmations,
    now,
  );

  const removeIds = new Set(toRemove.map((r) => r.id));
  const promoteIds = new Set(toPromote.map((r) => r.id));

  const result: ExpertiseRecord[] = [];
  for (const record of records) {
    if (removeIds.has(record.id)) {
      continue;
    }
    if (promoteIds.has(record.id)) {
      result.push({
        ...record,
        classification: "foundational" as Classification,
      });
    } else {
      result.push(record);
    }
  }

  return {
    records: result,
    promoted: toPromote.length,
    removed: toRemove.length,
  };
}

function getRemoveBreakdown(
  records: ExpertiseRecord[],
  config: {
    classification_defaults: {
      shelf_life: { tactical: number; observational: number };
    };
  },
  minConfirmations: number,
  now: Date,
): { observational: number; tactical: number } {
  const shelfLife = config.classification_defaults.shelf_life;
  let observational = 0;
  let tactical = 0;

  for (const record of records) {
    const score = computeConfirmationScore(record);
    const stale = isRecordStale(record, now, shelfLife);
    if (stale && score < minConfirmations) {
      if (record.classification === "observational") {
        observational++;
      } else if (record.classification === "tactical") {
        tactical++;
      }
    }
  }

  return { observational, tactical };
}

export function registerConsolidateCommand(program: Command): void {
  program
    .command("consolidate")
    .argument("[domain]", "expertise domain to consolidate")
    .description(
      "Consolidate domain knowledge: promote confirmed records and remove expired ones",
    )
    .option("--analyze", "dry-run: show what would change (default behavior)")
    .option("--auto", "apply all consolidation actions")
    .option(
      "--min-confirmations <n>",
      "minimum confirmation score for promotion (default: 1)",
      "1",
    )
    .option("--dry-run", "alias for --analyze")
    .action(
      async (domain: string | undefined, options: Record<string, unknown>) => {
        const jsonMode = program.opts().json === true;
        const minConfirmations =
          Number.parseInt(options.minConfirmations as string, 10) || 1;
        const isAuto = options.auto === true;

        if (isAuto) {
          await handleAuto(domain, jsonMode, minConfirmations);
        } else {
          await handleAnalyze(domain, jsonMode, minConfirmations);
        }
      },
    );
}

async function handleAnalyze(
  domain: string | undefined,
  jsonMode: boolean,
  minConfirmations: number,
): Promise<void> {
  const config = await readConfig();
  const now = new Date();

  if (domain && !config.domains.includes(domain)) {
    const msg = `Domain "${domain}" not found in config.`;
    if (jsonMode) {
      outputJsonError("consolidate", msg);
    } else {
      console.error(chalk.red(`Error: ${msg}`));
    }
    process.exitCode = 1;
    return;
  }

  const domainsToProcess = domain ? [domain] : config.domains;
  const domainResults: Array<{
    domain: string;
    before: number;
    promoted: number;
    removed: number;
    after: number;
    utilization: number;
    warnings: string[];
    toPromote: ExpertiseRecord[];
    toRemoveBreakdown: { observational: number; tactical: number };
    noOutcomeCount: number;
  }> = [];

  for (const d of domainsToProcess) {
    const filePath = getExpertisePath(d);
    const records = await readExpertiseFile(filePath);
    const { toPromote, toRemove, noOutcomeCount } = analyzeConsolidation(
      records,
      config,
      minConfirmations,
      now,
    );
    const breakdown = getRemoveBreakdown(
      records,
      config,
      minConfirmations,
      now,
    );
    const afterCount = records.length - toRemove.length;
    const health = calculateDomainHealth(
      records,
      config.governance.max_entries,
      config.classification_defaults.shelf_life,
    );
    const utilization = Math.round(
      (afterCount / config.governance.max_entries) * 100,
    );
    const warnings: string[] = [];
    if (noOutcomeCount > 0) {
      warnings.push(`No outcome data for ${noOutcomeCount} records`);
    }

    domainResults.push({
      domain: d,
      before: records.length,
      promoted: toPromote.length,
      removed: toRemove.length,
      after: afterCount,
      utilization,
      warnings,
      toPromote,
      toRemoveBreakdown: breakdown,
      noOutcomeCount,
    });

    // Suppress unused health variable warning
    void health;
  }

  if (jsonMode) {
    outputJson({
      success: true,
      command: "consolidate",
      action: "analyze",
      domains: domainResults.map((r) => ({
        domain: r.domain,
        before: r.before,
        promoted: r.promoted,
        removed: r.removed,
        after: r.after,
        utilization: r.utilization,
        warnings: r.warnings,
      })),
    });
    return;
  }

  for (const result of domainResults) {
    if (!isQuiet()) {
      console.log(
        `${chalk.bold("Domain:")} ${chalk.cyan(result.domain)} ${muted(`(${result.before} records)`)}`,
      );
    }

    if (result.promoted > 0 && !isQuiet()) {
      console.log(
        `  ${brand(`Promote to foundational: ${result.promoted} records`)} ${muted(`(score >= ${minConfirmations})`)}`,
      );
      for (const r of result.toPromote) {
        const score = computeConfirmationScore(r);
        const label = "name" in r ? (r as { name: string }).name : r.type;
        console.log(
          `    - ${accent(r.id ?? "(no id)")} ${muted(`${r.type}:`)} ${label} ${muted(`(score: ${score})`)}`,
        );
      }
    }

    if (result.removed > 0 && !isQuiet()) {
      console.log(
        `  ${chalk.yellow(`Remove expired: ${result.removed} records`)}`,
      );
      if (result.toRemoveBreakdown.observational > 0) {
        const shelfLife = 30;
        console.log(
          `    - ${result.toRemoveBreakdown.observational} observational ${muted(`(age > ${shelfLife}d)`)}`,
        );
      }
      if (result.toRemoveBreakdown.tactical > 0) {
        const shelfLife = 14;
        console.log(
          `    - ${result.toRemoveBreakdown.tactical} tactical ${muted(`(age > ${shelfLife}d, score < ${minConfirmations})`)}`,
        );
      }
    }

    if (!isQuiet()) {
      console.log(
        `  After: ${result.after} records ${muted(`(${result.utilization}% utilization)`)}`,
      );
    }

    if (result.noOutcomeCount > 0 && !isQuiet()) {
      console.log(
        chalk.yellow(
          `  Warning: No outcome data for ${result.noOutcomeCount} records. Use mulch outcome to track confirmation.`,
        ),
      );
    }

    // Suggest compact if still above warn_entries after consolidation
    const config2 = await readConfig();
    if (result.after > config2.governance.warn_entries && !isQuiet()) {
      console.log(
        chalk.dim(
          `  Hint: Domain still has ${result.after} records after consolidation. Consider running mulch compact.`,
        ),
      );
    }
  }
}

async function handleAuto(
  domain: string | undefined,
  jsonMode: boolean,
  minConfirmations: number,
): Promise<void> {
  const config = await readConfig();
  const now = new Date();

  if (domain && !config.domains.includes(domain)) {
    const msg = `Domain "${domain}" not found in config.`;
    if (jsonMode) {
      outputJsonError("consolidate", msg);
    } else {
      console.error(chalk.red(`Error: ${msg}`));
    }
    process.exitCode = 1;
    return;
  }

  const domainsToProcess = domain ? [domain] : config.domains;

  const domainResults = await Promise.all(
    domainsToProcess.map(async (d) => {
      const filePath = getExpertisePath(d);
      let promoted = 0;
      let removed = 0;
      let before = 0;
      let after = 0;
      let noOutcomeCount = 0;

      await withFileLock(filePath, async () => {
        const records = await readExpertiseFile(filePath);
        before = records.length;

        const analysis = analyzeConsolidation(
          records,
          config,
          minConfirmations,
          now,
        );
        noOutcomeCount = analysis.noOutcomeCount;

        const result = applyConsolidation(
          records,
          config,
          minConfirmations,
          now,
        );
        promoted = result.promoted;
        removed = result.removed;
        after = result.records.length;

        await writeExpertiseFile(filePath, result.records);
      });

      const health = calculateDomainHealth(
        await readExpertiseFile(filePath),
        config.governance.max_entries,
        config.classification_defaults.shelf_life,
      );
      const utilization = Math.round(
        (after / config.governance.max_entries) * 100,
      );
      const warnings: string[] = [];
      if (noOutcomeCount > 0) {
        warnings.push(`No outcome data for ${noOutcomeCount} records`);
      }

      return {
        domain: d,
        before,
        promoted,
        removed,
        after,
        utilization,
        warnings,
        health,
      };
    }),
  );

  if (jsonMode) {
    outputJson({
      success: true,
      command: "consolidate",
      action: "auto",
      domains: domainResults.map((r) => ({
        domain: r.domain,
        before: r.before,
        promoted: r.promoted,
        removed: r.removed,
        after: r.after,
        utilization: r.utilization,
        warnings: r.warnings,
      })),
    });
    return;
  }

  for (const result of domainResults) {
    if (!isQuiet()) {
      console.log(
        `${chalk.bold("Domain:")} ${chalk.cyan(result.domain)} ${muted(`(${result.before} records)`)}`,
      );
      if (result.promoted > 0) {
        console.log(
          `  ${brand(`Promoted to foundational: ${result.promoted} records`)}`,
        );
      }
      if (result.removed > 0) {
        console.log(
          `  ${chalk.yellow(`Removed expired: ${result.removed} records`)}`,
        );
      }
      console.log(
        `  After: ${result.after} records ${muted(`(${result.utilization}% utilization)`)}`,
      );
      for (const w of result.warnings) {
        console.log(
          chalk.yellow(
            `  Warning: ${w}. Use mulch outcome to track confirmation.`,
          ),
        );
      }
    }
  }

  const totalPromoted = domainResults.reduce((s, r) => s + r.promoted, 0);
  const totalRemoved = domainResults.reduce((s, r) => s + r.removed, 0);

  if (!isQuiet()) {
    console.log(
      `\n${brand("✓")} ${brand(`Applied consolidation: ${totalPromoted} promoted, ${totalRemoved} removed`)}`,
    );
  }
}
