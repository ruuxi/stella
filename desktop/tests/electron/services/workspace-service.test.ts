import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceService } from '../../../electron/services/workspace-service.js'

const tempHomes: string[] = []

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stella-workspace-service-'))
  tempHomes.push(dir)
  return dir
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('WorkspaceService', () => {
  it('returns no workspace panels when the feature is disabled', async () => {
    const stellaHome = createTempHome()
    const panelsDir = path.resolve(stellaHome, '..', 'workspace', 'panels')
    fs.mkdirSync(panelsDir, { recursive: true })
    fs.writeFileSync(path.join(panelsDir, 'pd_focus.tsx'), 'export default function Panel() { return null }')

    const service = new WorkspaceService(() => stellaHome, () => false)

    await expect(service.listWorkspacePanels()).resolves.toEqual([])
  })
})
