import { runInRepo } from '../utils.ts'
import type { RunOptions } from '../types.js'

export async function test(options: RunOptions) {
	await runInRepo({
		...options,
		repo: 'vendurehq/storefront-qwik-starter',
		branch: 'main',
		build: 'build',
		test: 'fmt',
	})
}
