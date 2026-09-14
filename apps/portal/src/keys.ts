import type { InjectionKey } from 'vue'
import type { PortalFoundation } from './foundation'
import type { SceneCoordinator } from './coordinator'

export const foundationKey: InjectionKey<PortalFoundation> = Symbol('twin-foundation')
export const coordinatorKey: InjectionKey<SceneCoordinator> = Symbol('twin-coordinator')
