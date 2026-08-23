/**
 * `mediagen mark` — applies the same two markings to media that already
 * exists, in place.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { labelledPathFor, markFile, type MarkingResult } from '../../marking/mark.js'
import { LABEL_POSITIONS, isLabelPosition } from '../../marking/position.js'
import { reportError, writeJson, writeLine, type Outcome } from '../output.js'
import { loadConfig } from '../../config/resolve.js'

interface MarkOptions {
  visibleLabel?: boolean
  /** `--no-mark` arrives here as false; absent means "not stated". */
  mark?: boolean
  modified?: boolean
  labelPosition?: string
  inPlace?: boolean
  output?: string
  model?: string
  provider?: string
  json?: boolean
}

export function buildMarkCommand(outcome: Outcome): Command {
  return new Command('mark')
    .description('Mark existing media as AI-generated, in place')
    .argument('<file...>', 'files to mark')
    .option('--visible-label', 'composite a visible AI disclosure into the media')
    .option('--modified', 'label it as human media a model altered, not media a model made')
    .option(
      '--label-position <where>',
      `where the visible label sits: ${LABEL_POSITIONS.join(', ')}`,
    )
    .option('--output <path>', 'where the labelled copy goes; only with a single file')
    .option('--in-place', 'overwrite the original with the labelled version')
    .option('--no-mark', 'skip the machine-readable marker (use with --visible-label)')
    .option('--provider <name>', 'record which provider produced it')
    .option('--model <id>', 'record which model produced it')
    .option('--json', 'emit exactly one JSON object on stdout')
    .exitOverride()
    .addHelpText(
      'after',
      `
The machine-readable marker is the IPTC/XMP DigitalSourceType that platforms
read. It is written by default here, because marking is the whole point of the
command; --visible-label composites the European Commission's official label.

That label comes in two forms. By default it claims the media was generated
outright; --modified claims a model altered media a person made.

A visible label destroys pixels, so it is written to a copy named alongside the
original — photo.png becomes photo.labelled.png — and the original is left as
it was. --output names the copy; --in-place overwrites instead, which cannot be
undone. The machine-readable marker only adds metadata and is always written in
place.

A file that already declares a digital source type is left as it is and
reported, rather than having whatever the provider recorded overwritten.

No C2PA manifest is written. One only carries provenance if it is signed, and
a test-signed manifest would look like provenance while carrying none.`,
    )
    .action(async (files: string[], options: MarkOptions) => {
      const json = options.json === true
      try {
        // Both switches: what the flags say, else what is configured, else
        // this command's own defaults. The marker is on by default because
        // marking is the point of the command; the label is not, because it
        // rewrites pixels. `layer` distinguishes a configured `false` from
        // nothing configured at all, which a `??` on the value cannot.
        const config = loadConfig()
        const machineReadable = options.mark ?? configured(config.mark) ?? true
        const wantsLabel = options.visibleLabel ?? configured(config.visibleLabel) ?? false

        if (!machineReadable && !wantsLabel) {
          throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'Nothing to do.', {
            hint: 'Drop --no-mark, or add --visible-label.',
          })
        }

        if (options.output !== undefined && files.length > 1) {
          throw new MediagenError(
            ERROR_CODE.VALIDATION_ERROR,
            '--output names one file, but several were given.',
            { hint: 'Drop --output and each labelled copy is named after its original.' },
          )
        }

        const results: MarkingResult[] = []
        for (const file of files) {
          results.push(
            await markFile(
              file,
              {
                machineReadable,
                visibleLabel: wantsLabel,
                labelKind: options.modified === true ? 'modified' : 'generated',
                ...position(options.labelPosition),
                ...(wantsLabel && options.inPlace !== true
                  ? { outputPath: options.output ?? labelledPathFor(file) }
                  : {}),
              },
              {
                ...(options.provider === undefined ? {} : { provider: options.provider }),
                ...(options.model === undefined ? {} : { model: options.model }),
              },
            ),
          )
        }

        outcome.code = report(results, json)
      } catch (error) {
        outcome.code = reportError(error, json)
      }
    })
}

/** A configured value, or undefined when nothing set one. */
function configured(setting: { value: boolean; layer: string }): boolean | undefined {
  return setting.layer === 'default' ? undefined : setting.value
}

function report(results: readonly MarkingResult[], json: boolean): ExitCode {
  if (json) {
    writeJson({ success: true, marked: results })
    return EXIT_CODE.SUCCESS
  }

  for (const result of results) {
    const notes: string[] = []
    if (result.sourcePath !== undefined) notes.push(`copied from ${result.sourcePath}`)
    if (result.machineReadableWritten) notes.push('marked')
    if (result.alreadyMarked) notes.push('already declared a source type, left as it was')
    if (result.visibleLabelWritten) {
      notes.push(
        result.labelPosition === undefined
          ? 'visible label added'
          : `visible label added, ${result.labelPosition}`,
      )
    }

    writeLine(`${result.filePath}: ${notes.join('; ')}`)
  }

  return EXIT_CODE.SUCCESS
}

function position(value: string | undefined) {
  if (value === undefined) return {}

  if (!isLabelPosition(value)) {
    throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, `Unknown label position "${value}".`, {
      hint: `Use one of: ${LABEL_POSITIONS.join(', ')}.`,
    })
  }

  return { labelPosition: value }
}
