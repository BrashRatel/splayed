import { type BackendConfig, type Config, routeForBackend } from "../core/config.ts";
import type { ChainId } from "../core/profiles.ts";
import { RoutedTransport, type Transport } from "../net/transport.ts";
import { EsploraBackend } from "./esplora.ts";
import { rpcAuthorization, RpcBackend } from "./rpc.ts";
import { BackendError, type ChainBackend } from "./types.ts";

export type TransportFactory = (
  config: Config,
  chain: ChainId,
  backend: BackendConfig,
) => Transport;

export const defaultTransportFactory: TransportFactory = (config, chain, backend) =>
  new RoutedTransport(routeForBackend(config, chain, backend));

export async function createBackend(
  config: Config,
  chain: ChainId,
  backend: BackendConfig,
  options: { transportFactory?: TransportFactory; env?: Record<string, string | undefined> } = {},
): Promise<ChainBackend> {
  const transport = (options.transportFactory ?? defaultTransportFactory)(config, chain, backend);
  switch (backend.kind) {
    case "esplora":
      return new EsploraBackend(chain, backend, transport);
    case "rpc":
      return new RpcBackend(
        chain,
        backend,
        transport,
        await rpcAuthorization(backend.auth, options.env ?? Deno.env.toObject()),
        config.profile.chains[chain].rpc?.requiredDeployment,
      );
    case "electrum":
      throw new BackendError(
        "Electrum backends are planned for the next milestone; use esplora or rpc for now",
      );
  }
}
