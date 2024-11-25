import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import type {
	EnvironmentData,
	Overrides,
	ProcessEnv,
	RepoOptions,
	RunOptions,
	Task,
} from './types.d.ts'
//eslint-disable-next-line n/no-unpublished-import
import { detect, AGENTS, Agent, getCommand } from '@antfu/ni'
import actionsCore from '@actions/core'
// eslint-disable-next-line n/no-unpublished-import
import * as semver from 'semver'
import { execSync } from 'child_process'

const isGitHubActions = !!process.env.GITHUB_ACTIONS

let qwikPath: string
let cwd: string
let env: ProcessEnv

function cd(dir: string) {
	cwd = path.resolve(cwd, dir)
}

export async function $(
	literals: TemplateStringsArray,
	...values: any[]
): Promise<string> {
	const cmd = literals.reduce(
		(result, current, i) =>
			result + current + (values?.[i] != null ? `${values[i]}` : ''),
		'',
	)

	if (isGitHubActions) {
		actionsCore.startGroup(`${cwd} $> ${cmd}`)
	} else {
		console.log(`${cwd} $> ${cmd}`)
	}

	const result = execSync(cmd, {
		cwd,
		encoding: 'utf-8',
	})

	if (isGitHubActions) {
		actionsCore.endGroup()
	}

	return result
}

export async function setupEnvironment(): Promise<EnvironmentData> {
	const root = dirnameFrom(import.meta.url)
	const workspace = path.resolve(root, 'workspace')
	qwikPath = path.resolve(workspace, 'qwik')
	cwd = process.cwd()
	env = {
		...process.env,
		CI: 'true',
		YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', // to avoid errors with mutated lockfile due to overrides
		NODE_OPTIONS: '--max-old-space-size=6144', // GITHUB CI has 7GB max, stay below
		ECOSYSTEM_CI: 'true', // flag for tests, can be used to conditionally skip irrelevant tests.
	}
	initWorkspace(workspace)
	return { root, workspace, qwikPath, cwd, env }
}

function initWorkspace(workspace: string) {
	if (!fs.existsSync(workspace)) {
		fs.mkdirSync(workspace, { recursive: true })
	}
	const eslintrc = path.join(workspace, '.eslintrc.json')
	if (!fs.existsSync(eslintrc)) {
		fs.writeFileSync(eslintrc, '{"root":true}\n', 'utf-8')
	}
	const editorconfig = path.join(workspace, '.editorconfig')
	if (!fs.existsSync(editorconfig)) {
		fs.writeFileSync(editorconfig, 'root = true\n', 'utf-8')
	}
	const tsconfig = path.join(workspace, 'tsconfig.json')
	if (!fs.existsSync(tsconfig)) {
		fs.writeFileSync(tsconfig, '{}\n', 'utf-8')
	}
}

export async function setupRepo(options: RepoOptions) {
	if (options.branch == null) {
		options.branch = 'main'
	}
	if (options.shallow == null) {
		options.shallow = true
	}

	let { repo, commit, branch, tag, dir, shallow } = options
	if (!dir) {
		throw new Error('setupRepo must be called with options.dir')
	}
	if (!repo.includes(':')) {
		repo = `https://github.com/${repo}.git`
	}

	let needClone = true
	if (fs.existsSync(dir)) {
		const _cwd = cwd
		cd(dir)
		let currentClonedRepo: string | undefined
		try {
			currentClonedRepo = await $`git ls-remote --get-url`
		} catch {
			// when not a git repo
		}
		cd(_cwd)

		if (repo === currentClonedRepo) {
			needClone = false
		} else {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	}

	if (needClone) {
		await $`git -c advice.detachedHead=false clone ${
			shallow ? '--depth=1 --no-tags' : ''
		} --branch ${tag || branch} ${repo} ${dir}`
	}
	cd(dir)
	await $`git clean -fdxq`
	await $`git fetch ${shallow ? '--depth=1 --no-tags' : '--tags'} origin ${
		tag ? `tag ${tag}` : `${commit || branch}`
	}`
	if (shallow) {
		await $`git -c advice.detachedHead=false checkout ${
			tag ? `tags/${tag}` : `${commit || branch}`
		}`
	} else {
		await $`git checkout ${branch}`
		await $`git merge FETCH_HEAD`
		if (tag || commit) {
			await $`git reset --hard ${tag || commit}`
		}
	}
}

function toCommand(
	task: Task | Task[] | void,
	agent: Agent,
): ((scripts: any) => Promise<any>) | void {
	return async (scripts: any) => {
		const tasks = Array.isArray(task) ? task : [task]
		for (const task of tasks) {
			const parsedCmd = typeof task === 'string' && parseCommand(task)
			if (task == null || task === '') {
				continue
			} else if (typeof task === 'string' && parsedCmd) {
				if (scripts[parsedCmd.cmd] != null) {
					const runTaskWithAgent = getCommand(
						agent,
						'run',
						[parsedCmd.cmd, parsedCmd.flags].filter((v): v is string => !!v),
					)
					await $`${runTaskWithAgent}`
				} else {
					await $`${task}`
				}
			} else if (typeof task === 'function') {
				await task()
			} else if (typeof task === 'object' && task?.script) {
				if (scripts[task.script] != null) {
					const runTaskWithAgent = getCommand(agent, 'run', [
						task.script,
						...(task.args ?? []),
					])
					await $`${runTaskWithAgent}`
				} else {
					throw new Error(
						`invalid task, script "${task.script}" does not exist in package.json`,
					)
				}
			} else {
				throw new Error(
					`invalid task, expected string or function but got ${typeof task}: ${task}`,
				)
			}
		}
	}
}

/**
 * Returns command and flags from the string
 * @example
 * "build" => { cmd: "build" }
 * "build --some-flag" => { cmd: "build", flags: "--some-flag=true" }
 * "build test foo bar" => null
 */
function parseCommand(command: string): { cmd: string; flags?: string } | null {
	const regex = /^(\w+)(?:\s+(--.+))?$/
	const match = command.trim().match(regex)

	if (!match) {
		return null // Invalid structure
	}
	const [, cmd, flags] = match
	if (!cmd) {
		// Command is required
		return null
	}
	return { cmd, flags }
}

export async function runInRepo(options: RunOptions & RepoOptions) {
	if (options.verify == null) {
		options.verify = true
	}
	if (options.skipGit == null) {
		options.skipGit = false
	}
	if (options.branch == null) {
		options.branch = 'main'
	}

	const {
		build,
		test,
		repo,
		branch,
		tag,
		commit,
		skipGit,
		verify,
		beforeInstall,
		beforeBuild,
		beforeTest,
	} = options

	const dir = path.resolve(
		options.workspace,
		options.dir || repo.substring(repo.lastIndexOf('/') + 1),
	)

	if (!skipGit) {
		await setupRepo({ repo, dir, branch, tag, commit })
	} else {
		cd(dir)
	}
	if (options.agent == null) {
		const detectedAgent = await detect({ cwd: dir, autoInstall: false })
		if (detectedAgent == null) {
			throw new Error(`Failed to detect packagemanager in ${dir}`)
		}
		options.agent = detectedAgent
	}
	if (!AGENTS[options.agent]) {
		throw new Error(
			`Invalid agent ${options.agent}. Allowed values: ${Object.keys(
				AGENTS,
			).join(', ')}`,
		)
	}

	const agent = options.agent
	const beforeInstallCommand = toCommand(beforeInstall, agent)
	const beforeBuildCommand = toCommand(beforeBuild, agent)
	const beforeTestCommand = toCommand(beforeTest, agent)
	const buildCommand = toCommand(build, agent)
	const testCommand = toCommand(test, agent)

	const pkgFile = path.join(dir, 'package.json')
	const pkg = JSON.parse(await fs.promises.readFile(pkgFile, 'utf-8'))

	await beforeInstallCommand?.(pkg.scripts)

	if (verify && test) {
		const frozenInstall = getCommand(agent, 'frozen')
		await $`${frozenInstall}`
		await beforeBuildCommand?.(pkg.scripts)
		await buildCommand?.(pkg.scripts)
		await beforeTestCommand?.(pkg.scripts)
		await testCommand?.(pkg.scripts)
	}
	const overrides = options.overrides || {}
	// TODO
	if (options.release) {
		if (overrides.vite && overrides.vite !== options.release) {
			throw new Error(
				`conflicting overrides.vite=${overrides.vite} and --release=${options.release} config. Use either one or the other`,
			)
		} else {
			overrides.vite = options.release
		}
	} else {
		overrides['@builder.io/qwik'] ||= `${options.qwikPath}/packages/qwik`
		overrides['@builder.io/qwik-city'] ||=
			`${options.qwikPath}/packages/qwik-city`
		overrides['eslint-plugin-qwik'] ||=
			`${options.qwikPath}/packages/eslint-plugin-qwik`
	}
	await applyPackageOverrides(dir, pkg, overrides)
	await beforeBuildCommand?.(pkg.scripts)
	await buildCommand?.(pkg.scripts)
	if (test) {
		await beforeTestCommand?.(pkg.scripts)
		await testCommand?.(pkg.scripts)
	}
	return { dir }
}

export async function setupQwikRepo(options: Partial<RepoOptions>) {
	const repo = options.repo || 'QwikDev/qwik'
	await setupRepo({
		repo,
		dir: qwikPath,
		branch: 'main',
		shallow: true,
		...options,
	})

	try {
		const rootPackageJsonFile = path.join(qwikPath, 'package.json')
		const rootPackageJson = JSON.parse(
			await fs.promises.readFile(rootPackageJsonFile, 'utf-8'),
		)
		const needsWrite = await overridePackageManagerVersion(
			rootPackageJson,
			'pnpm',
		)
		if (needsWrite) {
			fs.writeFileSync(
				rootPackageJsonFile,
				JSON.stringify(rootPackageJson, null, 2),
				'utf-8',
			)
			if (rootPackageJson.devDependencies?.pnpm) {
				await $`pnpm install -Dw pnpm --lockfile-only`
			}
		}
	} catch (e) {
		throw new Error(`Failed to setup Qwik repo`, { cause: e })
	}
}

export async function getPermanentRef() {
	cd(qwikPath)
	try {
		const ref = await $`git log -1 --pretty=format:%H`
		return ref
	} catch (e) {
		console.warn(`Failed to obtain perm ref. ${e}`)
		return undefined
	}
}

export async function buildQwik({ verify = false }) {
	cd(qwikPath)
	const frozenInstall = getCommand('pnpm', 'frozen')
	const runBuild = getCommand('pnpm', 'run', ['build.full'])
	const runTest = getCommand('pnpm', 'run', ['test'])
	await $`${frozenInstall}`
	await $`${runBuild}`
	if (verify) {
		await $`${runTest}`
	}
}

export async function bisectQwik(
	good: string,
	runSuite: () => Promise<Error | void>,
) {
	// sometimes vite build modifies files in git, e.g. LICENSE.md
	// this would stop bisect, so to reset those changes
	const resetChanges = async () => $`git reset --hard HEAD`

	try {
		cd(qwikPath)
		await resetChanges()
		await $`git bisect start`
		await $`git bisect bad`
		await $`git bisect good ${good}`
		let bisecting = true
		while (bisecting) {
			const commitMsg = await $`git log -1 --format=%s`
			const isNonCodeCommit = commitMsg.match(/^(?:release|docs)[:(]/)
			if (isNonCodeCommit) {
				await $`git bisect skip`
				continue // see if next commit can be skipped too
			}
			const error = await runSuite()
			cd(qwikPath)
			await resetChanges()
			const bisectOut = await $`git bisect ${error ? 'bad' : 'good'}`
			bisecting = bisectOut.substring(0, 10).toLowerCase() === 'bisecting:' // as long as git prints 'bisecting: ' there are more revisions to test
		}
	} catch (e) {
		console.log('error while bisecting', e)
	} finally {
		try {
			cd(qwikPath)
			await $`git bisect reset`
		} catch (e) {
			console.log('Error while resetting bisect', e)
		}
	}
}

function isLocalOverride(v: string): boolean {
	if (!v.includes('/') || v.startsWith('@')) {
		// not path-like (either a version number or a package name)
		return false
	}
	try {
		return !!fs.lstatSync(v)?.isDirectory()
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e
		}
		return false
	}
}

/**
 * utility to override packageManager version
 *
 * @param pkg parsed package.json
 * @param pm package manager to override eg. `pnpm`
 * @returns {boolean} true if pkg was updated, caller is responsible for writing it to disk
 */
async function overridePackageManagerVersion(
	pkg: { [key: string]: any },
	pm: string,
): Promise<boolean> {
	// TODO: needed?
	const versionInUse = pkg.packageManager?.startsWith(`${pm}@`)
		? pkg.packageManager.substring(pm.length + 1)
		: await $`${pm} --version`
	let overrideWithVersion: string | null = null
	if (pm === 'pnpm') {
		if (semver.eq(versionInUse, '7.18.0')) {
			// avoid bug with absolute overrides in pnpm 7.18.0
			overrideWithVersion = '7.18.1'
		}
	}
	if (overrideWithVersion) {
		console.warn(
			`detected ${pm}@${versionInUse} used in ${pkg.name}, changing pkg.packageManager and pkg.engines.${pm} to enforce use of ${pm}@${overrideWithVersion}`,
		)
		// corepack reads this and uses pnpm @ newVersion then
		pkg.packageManager = `${pm}@${overrideWithVersion}`
		if (!pkg.engines) {
			pkg.engines = {}
		}
		pkg.engines[pm] = overrideWithVersion

		if (pkg.devDependencies?.[pm]) {
			// if for some reason the pm is in devDependencies, that would be a local version that'd be preferred over our forced global
			// so ensure it here too.
			pkg.devDependencies[pm] = overrideWithVersion
		}

		return true
	}
	return false
}

export async function applyPackageOverrides(
	dir: string,
	pkg: any,
	overrides: Overrides = {},
) {
	const useFileProtocol = (v: string) =>
		isLocalOverride(v) ? `file:${path.resolve(v)}` : v
	// remove boolean flags
	overrides = Object.fromEntries(
		Object.entries(overrides)
			//eslint-disable-next-line @typescript-eslint/no-unused-vars
			.filter(([key, value]) => typeof value === 'string')
			.map(([key, value]) => [key, useFileProtocol(value as string)]),
	)
	await $`git clean -fdxq` // remove current install

	const agent = await detect({ cwd: dir, autoInstall: false })
	if (!agent) {
		throw new Error(`failed to detect packageManager in ${dir}`)
	}
	// Remove version from agent string:
	// yarn@berry => yarn
	// pnpm@6, pnpm@7 => pnpm
	const pm = agent?.split('@')[0]

	await overridePackageManagerVersion(pkg, pm)

	if (pm === 'pnpm') {
		if (!pkg.devDependencies) {
			pkg.devDependencies = {}
		}
		pkg.devDependencies = {
			...pkg.devDependencies,
			...overrides, // overrides must be present in devDependencies or dependencies otherwise they may not work
		}
		if (!pkg.pnpm) {
			pkg.pnpm = {}
		}
		pkg.pnpm.overrides = {
			...pkg.pnpm.overrides,
			...overrides,
		}
	} else if (pm === 'yarn') {
		pkg.resolutions = {
			...pkg.resolutions,
			...overrides,
		}
	} else if (pm === 'npm') {
		pkg.overrides = {
			...pkg.overrides,
			...overrides,
		}
		// npm does not allow overriding direct dependencies, force it by updating the blocks themselves
		for (const [name, version] of Object.entries(overrides)) {
			if (pkg.dependencies?.[name]) {
				pkg.dependencies[name] = version
			}
			if (pkg.devDependencies?.[name]) {
				pkg.devDependencies[name] = version
			}
		}
	} else {
		throw new Error(`unsupported package manager detected: ${pm}`)
	}
	const pkgFile = path.join(dir, 'package.json')
	await fs.promises.writeFile(pkgFile, JSON.stringify(pkg, null, 2), 'utf-8')

	// use of `ni` command here could cause lockfile violation errors so fall back to native commands that avoid these
	if (pm === 'pnpm') {
		await $`pnpm install --prefer-frozen-lockfile --strict-peer-dependencies false`
	} else if (pm === 'yarn') {
		await $`yarn install`
	} else if (pm === 'npm') {
		await $`npm install`
	}
}

export function dirnameFrom(url: string) {
	return path.dirname(fileURLToPath(url))
}

export function parseQwikMajor(qwikPath: string): number {
	const content = fs.readFileSync(
		path.join(qwikPath, 'packages', 'qwik', 'package.json'),
		'utf-8',
	)
	const pkg = JSON.parse(content)
	return parseMajorVersion(pkg.version)
}

export function parseMajorVersion(version: string) {
	return parseInt(version.split('.', 1)[0], 10)
}
