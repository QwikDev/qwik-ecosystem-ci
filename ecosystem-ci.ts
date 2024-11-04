import fs from 'fs'
import path from 'path'
import process from 'process'
import { cac } from 'cac'

import {
	setupEnvironment,
	setupQwikRepo,
	buildQwik,
	bisectQwik,
	parseQwikMajor,
	parseMajorVersion,
} from './utils.ts'
import type { CommandOptions, RunOptions } from './types.d.ts'

const QWIK_REPO = 'QwikDev/qwik'

const cli = cac()
cli
	.command('[...suites]', 'build qwik and run selected suites')
	.option('--verify', 'verify checkouts by running tests', { default: false })
	.option('--repo <repo>', 'qwik repository to use', { default: QWIK_REPO })
	.option('--branch <branch>', 'qwik branch to use', { default: 'main' })
	.option('--tag <tag>', 'qwik tag to use')
	.option('--commit <commit>', 'qwik commit sha to use')
	.option('--release <version>', 'qwik release to use from npm registry')
	.action(async (suites, options: CommandOptions) => {
		const { root, qwikPath, workspace } = await setupEnvironment()
		const suitesToRun = getSuitesToRun(suites, root)
		let qwikMajor
		if (!options.release) {
			await setupQwikRepo(options)
			await buildQwik({ verify: options.verify })
			qwikMajor = parseQwikMajor(qwikPath)
		} else {
			qwikMajor = parseMajorVersion(options.release)
		}
		const runOptions: RunOptions = {
			root,
			qwikPath,
			qwikMajor,
			workspace,
			release: options.release,
			verify: options.verify,
			skipGit: false,
		}
		for (const suite of suitesToRun) {
			await run(suite, runOptions)
		}
	})

cli
	.command('build-qwik', 'build qwik only')
	.option('--verify', 'verify qwik checkout by running tests', {
		default: false,
	})
	.option('--repo <repo>', 'qwik repository to use', { default: QWIK_REPO })
	.option('--branch <branch>', 'qwik branch to use', { default: 'main' })
	.option('--tag <tag>', 'qwik tag to use')
	.option('--commit <commit>', 'qwik commit sha to use')
	.action(async (options: CommandOptions) => {
		await setupEnvironment()
		await setupQwikRepo(options)
		await buildQwik({ verify: options.verify })
	})

cli
	.command('run-suites [...suites]', 'run single suite with pre-built qwik')
	.option(
		'--verify',
		'verify checkout by running tests before using local qwik',
		{ default: false },
	)
	.option('--repo <repo>', 'qwik repository to use', { default: QWIK_REPO })
	.option('--release <version>', 'qwik release to use from npm registry')
	.action(async (suites, options: CommandOptions) => {
		const { root, qwikPath, workspace } = await setupEnvironment()
		const suitesToRun = getSuitesToRun(suites, root)
		const runOptions: RunOptions = {
			...options,
			root,
			qwikPath,
			qwikMajor: parseQwikMajor(qwikPath),
			workspace,
		}
		for (const suite of suitesToRun) {
			await run(suite, runOptions)
		}
	})

cli
	.command(
		'bisect [...suites]',
		'use git bisect to find a commit in qwik that broke suites',
	)
	.option('--good <ref>', 'last known good ref, e.g. a previous tag. REQUIRED!')
	.option('--verify', 'verify checkouts by running tests', { default: false })
	.option('--repo <repo>', 'qwik repository to use', { default: QWIK_REPO })
	.option('--branch <branch>', 'qwik branch to use', { default: 'main' })
	.option('--tag <tag>', 'qwik tag to use')
	.option('--commit <commit>', 'qwik commit sha to use')
	.action(async (suites, options: CommandOptions & { good: string }) => {
		if (!options.good) {
			console.log(
				'you have to specify a known good version with `--good <commit|tag>`',
			)
			process.exit(1)
		}
		const { root, qwikPath, workspace } = await setupEnvironment()
		const suitesToRun = getSuitesToRun(suites, root)
		let isFirstRun = true
		const { verify } = options
		const runSuite = async () => {
			try {
				await buildQwik({ verify: isFirstRun && verify })
				for (const suite of suitesToRun) {
					await run(suite, {
						verify: !!(isFirstRun && verify),
						skipGit: !isFirstRun,
						root,
						qwikPath,
						qwikMajor: parseQwikMajor(qwikPath),
						workspace,
					})
				}
				isFirstRun = false
				return null
			} catch (e) {
				return e
			}
		}
		await setupQwikRepo({ ...options, shallow: false })
		const initialError = await runSuite()
		if (initialError) {
			await bisectQwik(options.good, runSuite)
		} else {
			console.log(`no errors for starting commit, cannot bisect`)
		}
	})
cli.help()
cli.parse()

async function run(suite: string, options: RunOptions) {
	const { test } = await import(`./tests/${suite}.ts`)
	await test({
		...options,
		workspace: path.resolve(options.workspace, suite),
	})
}

function getSuitesToRun(suites: string[], root: string) {
	let suitesToRun: string[] = suites
	const availableSuites: string[] = fs
		.readdirSync(path.join(root, 'tests'))
		.filter((f: string) => !f.startsWith('_') && f.endsWith('.ts'))
		.map((f: string) => f.slice(0, -3))
	availableSuites.sort()
	if (suitesToRun.length === 0) {
		suitesToRun = availableSuites
	} else {
		const invalidSuites = suitesToRun.filter(
			(x) => !x.startsWith('_') && !availableSuites.includes(x),
		)
		if (invalidSuites.length) {
			console.log(`invalid suite(s): ${invalidSuites.join(', ')}`)
			console.log(`available suites: ${availableSuites.join(', ')}`)
			process.exit(1)
		}
	}
	return suitesToRun
}
