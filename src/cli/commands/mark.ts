/**
 * `mediagen mark` — applies the same two markings to media that already
 * exists, in place.
 */

import { Command } from 'commander'
import { ERROR_CODE, EXIT_CODE, MediagenError, type ExitCode } from '../../core/errors.js'
import { markFile, type MarkingResult } from '../../marking/mark.js'
import { LABEL_POSITIONS, isLabelPosition } from '../../marking/position.js'
import { reportError, writeJson, writeLine, type Outcome } from '../output.js'

interface MarkOptions {
  visibleLabel?: boolean
  noMark?: boolean
  modified?: boolean
  labelPosition?: string
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

A file that already declares a digital source type is left as it is and
reported, rather than having whatever the provider recorded overwritten.

No C2PA manifest is written. One only carries provenance if it is signed, and
a test-signed manifest would look like provenance while carrying none.`,
    )
    .action(async (files: string[], options: MarkOptions) => {
      const json = options.json === true
      try {
        const machineReadable = options.noMark !== true

        if (!machineReadable && options.visibleLabel !== true) {
          throw new MediagenError(ERROR_CODE.VALIDATION_ERROR, 'Nothing to do.', {
            hint: 'Drop --no-mark, or add --visible-label.',
          })
        }

        const results: MarkingResult[] = []
        for (const file of files) {
          results.push(
            await markFile(
              file,
              {
                machineReadable,
                visibleLabel: options.visibleLabel === true,
                labelKind: options.modified === true ? 'modified' : 'generated',
                ...position(options.labelPosition),
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

function report(results: readonly MarkingResult[], json: boolean): ExitCode {
  if (json) {
    writeJson({ success: true, marked: results })
    return EXIT_CODE.SUCCESS
  }

  for (const result of results) {
    const notes: string[] = []
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
