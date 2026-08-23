/**
 * `mediagen doctor` — what is configured, where it came from, and whether it
 * works.
 *
 * The four outcomes are kept distinct on purpose. "Not configured", "key
 * rejected", "unreachable" and "configured but not cheaply verifiable" call
 * for four different actions, and collapsing them into a red cross tells the
 * user to start guessing.
 */

import { Command } from 'commander'
import { EXIT_CODE, type ExitCode } from '../../core/errors.js'
import { command } from '../../core/invocation.js'
import { configFilePath } from '../../config/file.js'
import { LAYER_LABEL, maskSecret } from '../../config/layers.js'
import { loadConfig } from '../../config/resolve.js'
import { verifyProvider, type VerificationStatus } from '../../config/verify.js'
import { PROVIDERS } from '../../providers/registry.js'
import { reportError, writeJson, writeLine, type Outcome } from '../output.js'

export function buildDoctorCommand(outcome: Outcome): Command {
  return new Command('doctor')
    .description('Check credentials and reachability for every provider')
    .option('--offline', 'skip the live requests; report configuration only')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .addHelpText(
      'after',
      `
Exit codes:
  0 at least one provider is usable
  3 no provider is usable`,
    )
    .action(async (options: { offline?: boolean; json?: boolean }) => {
      try {
        outcome.code = await report(options.offline === true, options.json === true)
      } catch (error) {
        outcome.code = reportError(error, options.json === true)
      }
    })
}

interface Report {
  readonly provider: string
  readonly label: string
  readonly envVar: string
  readonly configured: boolean
  /** Which layer supplied the key, when one did. */
  readonly layer?: string
  readonly masked?: string
  readonly shadowed: readonly string[]
  readonly status: VerificationStatus | 'unchecked'
  readonly detail?: string
  readonly fix?: string
}

async function report(offline: boolean, json: boolean): Promise<ExitCode> {
  const config = loadConfig()

  const reports: Report[] = []
  for (const provider of PROVIDERS) {
    const resolved = config.apiKey(provider.id)

    if (!resolved) {
      reports.push({
        provider: provider.id,
        label: provider.label,
        envVar: provider.credential.envVar,
        configured: false,
        shadowed: [],
        status: 'missing',
        fix: command(`config set ${provider.id}`),
      })
      continue
    }

    const base = {
      provider: provider.id,
      label: provider.label,
      envVar: provider.credential.envVar,
      configured: true,
      layer: LAYER_LABEL[resolved.layer],
      masked: maskSecret(resolved.value),
      shadowed: resolved.shadowed.map((layer) => LAYER_LABEL[layer]),
    } as const

    if (offline) {
      reports.push({ ...base, status: 'unchecked' })
      continue
    }

    const verification = await verifyProvider(config, provider)
    reports.push({
      ...base,
      status: verification.status,
      ...(verification.detail === undefined ? {} : { detail: verification.detail }),
      ...(verification.status === 'rejected' ? { fix: command(`config set ${provider.id}`) } : {}),
    })
  }

  // A provider whose key is present counts as usable unless a live check said
  // otherwise. `unverifiable` is not a failure — it is the absence of a cheap
  // proof, not evidence against the key.
  const usable = reports.filter(
    (report) =>
      report.configured && report.status !== 'rejected' && report.status !== 'unreachable',
  )

  if (json) {
    writeJson({
      success: usable.length > 0,
      configFile: configFilePath(),
      defaultProvider: config.defaultProvider.value,
      defaultProviderLayer: LAYER_LABEL[config.defaultProvider.layer],
      providers: reports,
    })
    return usable.length > 0 ? EXIT_CODE.SUCCESS : EXIT_CODE.CONFIG
  }

  writeLine(
    `Default provider: ${config.defaultProvider.value} [${LAYER_LABEL[config.defaultProvider.layer]}]`,
  )
  writeLine(`Config file: ${configFilePath()}`)
  writeLine()

  for (const report of reports) {
    writeLine(`${report.label} (${report.provider})`)
    writeLine(`  ${describe(report, offline)}`)
    if (report.shadowed.length > 0) {
      writeLine(
        `  Also set in ${report.shadowed.join(' and ')}, shadowed by ${report.layer ?? '—'}.`,
      )
    }
    if (report.fix !== undefined) {
      writeLine(`  Fix: ${report.fix}`)
    }
    writeLine()
  }

  if (usable.length === 0) {
    writeLine('No provider is usable.')
    return EXIT_CODE.CONFIG
  }

  return EXIT_CODE.SUCCESS
}

function describe(report: Report, offline: boolean): string {
  switch (report.status) {
    case 'missing':
      return `Not configured. Set ${report.envVar}.`
    case 'unchecked':
      return `Key present ${report.masked} [${report.layer}]${offline ? '; not checked (--offline)' : ''}`
    case 'ok':
      return `Key present ${report.masked} [${report.layer}]; the provider accepted it.`
    case 'rejected':
      return `Key present ${report.masked} [${report.layer}]; the provider rejected it.`
    case 'unreachable':
      return `Key present ${report.masked} [${report.layer}]; could not reach the provider${
        report.detail === undefined ? '' : ` (${report.detail})`
      }.`
    case 'unverifiable':
      return `Key present ${report.masked} [${report.layer}]; no cheap way to verify it, so it is untested.`
  }
}
