import { runInRepo } from '../utils.ts'
import type { RunOptions } from '../types.d.ts'

export async function test(options: RunOptions) {
	await runInRepo({
		...options,
		repo: 'qwikifiers/qwik-ui',
		branch: 'main',
		build: 'build.qwik-ci',
		test: 'test.qwik-ci',
	})
}
