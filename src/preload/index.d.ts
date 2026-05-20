import type { PrintAgentApi } from './index'

declare global {
  interface Window {
    printAgent: PrintAgentApi
  }
}
