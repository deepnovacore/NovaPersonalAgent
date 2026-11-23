#!/usr/bin/env node
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {RelayServer,type RelayServerOptions} from './server.js';
import {MEDIA_DEFAULTS,type MediaOptions} from './media.js';

export interface RelayDeploymentConfig {
  dataDirectory: string;
  bootstrapTokenFile: string;
  bind?: string;
  port?: number;
  publicUrl?: string;
  externalTls?: boolean;
  trustedProxyAddresses?: string[];
  maxControlOperationsPerSpace?: number;
  tlsCertificateFile?: string;
  tlsKeyFile?: string;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  requestsPerMinute?: number;
  bootstrapPerMinute?: number;
  globalRequestsPerMinute?: number;
  globalBootstrapPerMinute?: number;
  maxRateSources?: number;
  /** Space voice media forwarding; disabled unless `media.enabled` is true. */
  media?: Omit<MediaOptions,'clock'>;
}
export function loadDeploymentConfig(path: string): RelayServerOptions {
  const config=JSON.parse(readFileSync(path,'utf8')) as RelayDeploymentConfig;
  if (!config || typeof config.dataDirectory!=='string' || typeof config.bootstrapTokenFile!=='string') throw new Error('dataDirectory and bootstrapTokenFile are required');
  if (config.tlsCertificateFile && !config.tlsKeyFile || config.tlsKeyFile && !config.tlsCertificateFile) throw new Error('TLS certificate and key must be configured together');
  process.umask(0o077);
  const directory=resolve(config.dataDirectory);mkdirSync(directory,{recursive:true,mode:0o700});
  const bootstrapToken=readFileSync(config.bootstrapTokenFile,'utf8').trim();
  if (bootstrapToken.length<24) throw new Error('bootstrap token must contain at least 24 characters');
  return {securityPath:join(directory,'security.sqlite'),mailboxPath:join(directory,'mailbox.sqlite'),bootstrapToken,
    port:config.port ?? 8080,...(config.bind===undefined?{}:{bind:config.bind}),
    ...(config.publicUrl===undefined?{}:{publicUrl:config.publicUrl}),
    ...(config.externalTls===undefined?{}:{externalTls:config.externalTls}),
    ...(config.trustedProxyAddresses===undefined?{}:{trustedProxyAddresses:config.trustedProxyAddresses}),
    ...(config.maxControlOperationsPerSpace===undefined?{}:{maxControlOperationsPerSpace:config.maxControlOperationsPerSpace}),
    ...(config.tlsCertificateFile && config.tlsKeyFile ? {tls:{cert:readFileSync(config.tlsCertificateFile),key:readFileSync(config.tlsKeyFile)}} : {}),
    ...(config.maxBodyBytes===undefined?{}:{maxBodyBytes:config.maxBodyBytes}),
    ...(config.maxResponseBytes===undefined?{}:{maxResponseBytes:config.maxResponseBytes}),
    ...(config.maxConnections===undefined?{}:{maxConnections:config.maxConnections}),
    ...(config.maxConnectionsPerIp===undefined?{}:{maxConnectionsPerIp:config.maxConnectionsPerIp}),
    ...(config.requestsPerMinute===undefined?{}:{requestsPerMinute:config.requestsPerMinute}),
    ...(config.bootstrapPerMinute===undefined?{}:{bootstrapPerMinute:config.bootstrapPerMinute}),
    ...(config.globalRequestsPerMinute===undefined?{}:{globalRequestsPerMinute:config.globalRequestsPerMinute}),
    ...(config.globalBootstrapPerMinute===undefined?{}:{globalBootstrapPerMinute:config.globalBootstrapPerMinute}),
    ...(config.maxRateSources===undefined?{}:{maxRateSources:config.maxRateSources}),
    ...(config.media===undefined?{}:{media:mediaConfig(config.media)})};
}
function mediaConfig(value: unknown): Omit<MediaOptions,'clock'> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('media must be an object');
  const {clock:_clock,...rest}=value as MediaOptions;
  if (rest.enabled!==undefined && typeof rest.enabled!=='boolean') throw new Error('media.enabled must be a boolean');
  for (const [key,option] of Object.entries(rest)) {
    if (key==='enabled') continue;
    if (!(key in MEDIA_DEFAULTS)) throw new Error(`unknown media option: ${key}`);
    if (typeof option!=='number' || !Number.isFinite(option) || option<=0) throw new Error(`media.${key} must be a positive number`);
  }
  return rest;
}
export async function main(args=process.argv.slice(2)):Promise<void> {
  if (args.length!==2 || args[0]!=='--config' || !args[1]) throw new Error('Usage: nova-relay --config /path/to/deployment.json');
  const server=new RelayServer(loadDeploymentConfig(args[1]));
  const address=await server.listen();process.stdout.write(`Relay listening at ${address}\n`);
  let closing=false;
  const close=():void=> {
    if(closing)return;closing=true;
    void server.close().catch(()=>{process.exitCode=1;});
  };
  process.once('SIGINT',close);process.once('SIGTERM',close);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  void main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'relay startup failed'}\n`);process.exitCode=1;});
}
