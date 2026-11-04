import {
	AppStorage as BaseAppStorage,
	CustomProvidersStore,
	getAppStorage,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
} from "@mariozechner/pi-web-ui";
import { CostStore } from "./stores/cost-store.js";
import { DiscoveredModelsStore } from "./stores/discovered-models-store.js";
import { TabkyraSessionsStore } from "./stores/sessions-store.js";
import { SkillsStore } from "./stores/skills-store.js";

/**
 * Extended AppStorage for Tabkyra with skills, memories, and prompts stores.
 */
export class TabkyraAppStorage extends BaseAppStorage {
	readonly skills: SkillsStore;
	readonly costs: CostStore;
	readonly discoveredModels: DiscoveredModelsStore;

	constructor() {
		// 1. Create all stores (no backend yet)
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new TabkyraSessionsStore();
		const customProviders = new CustomProvidersStore();
		const skills = new SkillsStore();
		const costs = new CostStore();
		const discoveredModels = new DiscoveredModelsStore();

		// 2. Gather configs from all stores
		const configs = [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			customProviders.getConfig(),
			sessions.getConfig(),
			skills.getConfig(),
			costs.getConfig(),
			discoveredModels.getConfig(),
		];

		// 3. Create backend with all configs
		const backend = new IndexedDBStorageBackend({
			dbName: "tabkyra-storage",
			version: 4, // v4: discovered-models store
			stores: configs,
		});

		// 4. Wire backend to all stores
		settings.setBackend(backend);
		providerKeys.setBackend(backend);
		customProviders.setBackend(backend);
		sessions.setBackend(backend);
		skills.setBackend(backend);
		costs.setBackend(backend);
		discoveredModels.setBackend(backend);

		// 5. Pass base stores to parent
		super(settings, providerKeys, sessions, customProviders, backend);

		// 6. Store references to tabkyra-specific stores
		this.skills = skills;
		this.costs = costs;
		this.discoveredModels = discoveredModels;
	}
}

/**
 * Helper to get typed Tabkyra storage.
 */
export function getTabkyraStorage(): TabkyraAppStorage {
	return getAppStorage() as TabkyraAppStorage;
}
