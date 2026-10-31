import { type BackendConfig, type Config, routeForBackend } from "../core/config.ts";
import type { ChainId } from "../core/profiles.ts";
import { RoutedTransport, type Transport } from "../net/transport.ts";
import { EsploraBackend } from "./esplora.ts";
import { ElectrumBackend } from "./electrum.ts";
import { rpcAuthorization, RpcBackend } from "./rpc.ts";
import { BackendError, type ChainBackend } from "./types.ts";

export type TransportFactory = (
  config: Config,
  chain: ChainId,
  backend: BackendConfig,
  caCerts?: string[],
) => Transport;

async function caCertsFor(backend: BackendConfig): Promise<string[] | undefined> {
  if (!backend.caFile) return undefined;
  try {
    return [await Deno.readTextFile(backend.caFile)];
  } catch (error) {
    throw new BackendError(`Cannot read ca_file ${backend.caFile}: ${(error as Error).message}`);
  }
}

export const defaultTransportFactory: TransportFactory = (config, chain, backend, caCerts) =>
  new RoutedTransport(routeForBackend(config, chain, backend), undefined, caCerts);

/** Lets tests replace raw TCP connections for Electrum. */
export type StreamFactory = (
  config: Config,
  chain: ChainId,
  backend: BackendConfig,
) => () => Promise<Deno.Conn>;

export async function createBackend(
  config: Config,
  chain: ChainId,
  backend: BackendConfig,
  options: {
    transportFactory?: TransportFactory;
    streamFactory?: StreamFactory;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ChainBackend> {
  const caCerts = await caCertsFor(backend);
  if (backend.kind === "electrum") {
    return new ElectrumBackend(
      chain,
      backend,
      routeForBackend(config, chain, backend),
      caCerts,
      options.streamFactory?.(config, chain, backend),
    );
  }
  const transport = (options.transportFactory ?? defaultTransportFactory)(
    config,
    chain,
    backend,
    caCerts,
  );
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
  }
}
