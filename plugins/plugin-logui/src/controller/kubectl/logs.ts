/*
 * Copyright 2019-2020 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from 'debug'
import PrettyPrintAnsiString from 'ansi_up'
import * as colors from 'colors/safe'
import { Abortable, Arguments, Registrar, Streamable } from '@kui-shell/core'
import { KubeOptions, doExecWithPty, defaultFlags as flags, isHelpRequest } from '@kui-shell/plugin-kubeui'

import commandPrefix from '../command-prefix'

interface LogOptions extends KubeOptions {
  f: string
  follow: string
  previous: boolean
  tail: number
}

const debug = Debug('plugin-logui/controller/kubectl/logs')

const literal = (match, p1, p2) => `${p1}${colors.blue(p2)}`
const literal2 = (match, p1, p2) => `${p1}${colors.cyan(p2)}`
const deemphasize = (match, p1, p2) => `${p1}${colors.gray(p2)}`
const deemphasize2 = (match, p1, p2, p3, p4) => `${deemphasize(match, p1, p2)}${p4}`

/**
 * Generate notes:
 *
 * - below, we use colors.blue (etc.) to inject ANSI control codes
 * - ansi_up then turns these into an HTML string; we tell it, via `use_classes: true`
 *   to use class names for the HTML colors
 * - then, the theme alignment comes from plugin-kubeui-client/web/css/colors.css
 *
 */
function decorateLogLines(lines: string): string {
  return (
    lines
      // informational extras, e.g. [INFO]
      .replace(/(\[.*?\])/g, (match, p1) => colors.gray(p1))
      // quoted strings
      .replace(/(\s+|=|:o)("([^\\"]|\\")*")/g, literal) // " hello" or "=hello" or ":hello"
      .replace(/(\s+|=|:)('([^\\']|\\')*')/g, literal) // same, but with ' instead of "
      // numbers
      .replace(/(=)(\d+(.\d+)?(ms)?)/g, literal) // e.g. =32
      // booleans
      .replace(/(\s+|=)(true|false)/g, literal2) // e.g. " true" or "=true"
      // go line numbers
      .replace(/(\s+)(\S+.go\s\d+:)/g, deemphasize) // e.g. streamwatcher.go 109:
      .replace(/(\s+)(\S+.go:\d+\])/g, deemphasize) // e.g. streamwatcher.go:109]
      // various timestamp formats
      .replace(
        /(\w{3}\s+\d\d?\s+\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}.\d{6}|\w{3}\s+\w{3}\s+\d\d?\s+\d{2}:\d{2}:\d{2}\s+\d{4}|\[(\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})\]|\w{3},\s+\d{2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+\w{3}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(.\d{3}?)|\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(.\d+)?)/g,
        (match, p1) => colors.cyan(p1)
      )
      // start/restart
      .replace(/(success|succeeded|starting|started|restarting|restarted)/gi, (match, p1) => colors.green(p1))
      // E/I/W lines
      .replace(/^(E\d+)/gm, (match, p1) => colors.red(p1)) // e.g. E0123
      .replace(/^(I\d+)/gm, (match, p1) => colors.gray(p1))
      .replace(/^(W\d+)/gm, (match, p1) => colors.yellow(p1))
      // errors
      .replace(/^(Failed|Failure|Error)/gm, (match, p1) => colors.red(p1))
      .replace(/([^_])(failed|error|timeout:?)/gi, (match, p1, p2) => `${p1}${colors.red(p2)}`)
      // warnings
      .replace(/((deleted|exit|warn)(ing)?:?)/gi, (match, p1) => colors.yellow(p1))
      // operator logs sometimes have components named by aa:bb or aa:bb:cc
      .replace(/(\s+)([a-zA-Z]+:[a-zA-Z]+(:[a-zA-Z]+)?)(\s+)/g, deemphasize2)
  )
}

/**
 * Send the request to a PTY for deeper handling, then (possibly) add
 * some ANSI control codes for coloring.
 *
 */
export async function doLogs(args: Arguments<LogOptions>) {
  const streamed = args.parsedOptions.follow || args.parsedOptions.f

  // if we are streaming (logs -f), and the user did not specify a
  // "--since", then add one, to prevent the default behavior of
  // kubectl which fetches quite a bit of history
  if (streamed && !args.parsedOptions.since) {
    // see https://github.com/kui-shell/plugin-kubeui/issues/210
    const since = '10s'
    args.parsedOptions.since = since
    args.argv.push('--since=since')
    args.command = args.command + ' --since=10s'
  }

  // if we are not streaming, and the user has not specified a
  // "--tail", then add one, for the same reason
  if (!streamed && !args.parsedOptions.tail) {
    const tail = 30
    args.parsedOptions.tail = tail
    args.argv.push('--tail=' + tail)
    args.command = args.command + ' --tail=' + tail
  }

  // set up the PTY stream; we want to stream to this stdout sink
  const stdout = await args.createOutputStream()

  // a bit of plumbing: tell the PTY that we will be handling everything
  const myExecOptions = Object.assign({}, args.execOptions, {
    rethrowErrors: true, // we want to handle errors
    quiet: true, // don't ever emit anything on your own
    replSilence: true, // repl: same thing
    echo: false, // do not even echo "ok"

    // the PTY will call this when the PTY process is ready; in
    // return, we send it back a consumer of streaming output
    onInit: (ptyJob: Abortable) => {
      let curLine: string

      // _ is one chunk of streaming output
      return (_: Streamable) => {
        if (args.block['isCancelled']) {
          ptyJob.abort()
        } else if (typeof _ === 'string') {
          // we only know how to handle strings
          if (/\n$/.test(_)) {
            const joined = curLine ? curLine + _ : _
            // if the output from the PTY already contains ANSI
            // control characters, then we won't add any of our
            // own. \x1b is ESCAPE
            // eslint-disable-next-line no-control-regex
            const fullLine = /\x1b/.test(joined) ? joined : decorateLogLines(joined)

            const lineDom = document.createElement('pre')
            lineDom.classList.add('pre-wrap', 'kubeui--logs')
            const formatter = new PrettyPrintAnsiString()
            // eslint-disable-next-line @typescript-eslint/camelcase
            formatter.use_classes = true
            lineDom.innerHTML = formatter.ansi_to_html(fullLine)
            curLine = undefined

            // here is where we emit to the REPL:
            stdout(lineDom)
          } else if (curLine) {
            // we did not get a terminal newline in this chunk
            curLine = curLine + _
          } else {
            // we did not get a terminal newline in this chunk
            curLine = _
          }
        }
      }
    }
  })

  // be careful not to smash the original execOptions!
  const myArgs = Object.assign({}, args, { execOptions: myExecOptions })
  return doExecWithPty(myArgs).catch(err => {
    if (isHelpRequest(args)) {
      return err
    } else {
      debug(err)
      return true
    }
  })
}

export default (registrar: Registrar) => {
  registrar.listen(`/${commandPrefix}/kubectl/logs`, doLogs, flags)
  registrar.listen(`/${commandPrefix}/k/logs`, doLogs, flags)
}
