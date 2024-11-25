import { runInRepo } from '../utils.ts'
import type { RunOptions } from '../types.d.ts'

export async function test(options: RunOptions) {
	await runInRepo({
		...options,
		repo: 'qwikdev/qwik-image',
		branch: 'main',
		build: 'build --skip-nx-cache',
		test: 'test',
	})
}
