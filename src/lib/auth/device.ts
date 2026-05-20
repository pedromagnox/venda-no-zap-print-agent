import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { hostname, release } from 'node:os'
import { machineId } from 'node-machine-id'
import { getSecure, setSecure } from '../storage/safeStorage'

const INSTALL_ID_KEY = 'agent_install_id'

export type DeviceFingerprint = {
  agentInstallId: string
  hostname: string
  machineIdHash: string | null
  osBuild: string
  osLocale: string
}

// UUID estável por instalação. Fonte primária da identidade do agente.
// node-machine-id é sinal secundário porque pode estar vazio em VMs/Docker.
export async function getOrCreateInstallId(): Promise<string> {
  const existing = await getSecure(INSTALL_ID_KEY)
  if (existing) return existing
  const id = randomUUID()
  await setSecure(INSTALL_ID_KEY, id)
  return id
}

async function getMachineIdHash(): Promise<string | null> {
  try {
    const raw = await machineId(true)
    if (!raw) return null
    return createHash('sha256').update(raw).digest('hex')
  } catch {
    return null
  }
}

export async function getFingerprint(): Promise<DeviceFingerprint> {
  const [agentInstallId, machineIdHash] = await Promise.all([
    getOrCreateInstallId(),
    getMachineIdHash()
  ])
  return {
    agentInstallId,
    hostname: hostname(),
    machineIdHash,
    osBuild: release(),
    osLocale: app.getLocale()
  }
}
