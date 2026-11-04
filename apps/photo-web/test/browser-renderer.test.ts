import { describe, it, expect, vi } from "vitest";
import { createPhotoWebMaskSurfaceValidator, probePhotoWebRenderer } from "../src/browser/renderer.ts";
const sha = "a".repeat(64);
const proof = {sdkVersion:"fixture",crateVersion:"0.27.0",manifestSha256:sha,manifestUrl:`/develop-engine/${sha}/manifest-0.27.0.json`};
const caps = {schemaVersion:1 as const,crateVersion:"0.27.0",settingsVersions:[9],engines:["niho-14"],features:["geometry" as const],maskKinds:["linear" as const],maskSurfaces:false};
function fixture() { return {ready:vi.fn(async()=>true),renderCapabilities:vi.fn(async()=>caps),dispose:vi.fn()}; }
function deferred<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve};}
describe("probePhotoWebRenderer",()=>{
 it("uses actual capability fields, disposes before publication, and pins Workbench to the exact same manifest",async()=>{
  const e=fixture();const make=vi.fn((manifestUrl: string)=>{void manifestUrl;return e});const result=await probePhotoWebRenderer({proof,signal:new AbortController().signal,createEngine:make});
  expect(e.dispose).toHaveBeenCalledOnce();expect(result?.capability).toEqual({sdkVersion:"fixture",crateVersion:"0.27.0",manifestSha256:sha,settingsVersions:[9],engines:["niho-14"],features:["geometry"],maskKinds:["linear"],maskSurfaces:false});
  expect(result?.engineAssets.manifestUrl()).toBe(make.mock.calls[0]?.[0]);expect(result?.engineAssets.preferNative).toBe(false);
  expect(Object.isFrozen(result?.capability.settingsVersions)).toBe(true);expect(result?.capability.settingsVersions).not.toBe(caps.settingsVersions);
 });
 it("does not construct a probe after pre-abort",async()=>{
  const c=new AbortController();c.abort();const make=vi.fn(()=>fixture());expect(await probePhotoWebRenderer({proof,signal:c.signal,createEngine:make})).toBeNull();expect(make).not.toHaveBeenCalled();
 });
 it("aborts synchronously while ready is pending and discards late readiness",async()=>{
  const e=fixture();const wait=deferred<boolean>();e.ready=vi.fn(()=>wait.promise);const c=new AbortController();const pending=probePhotoWebRenderer({proof,signal:c.signal,createEngine:()=>e});c.abort();expect(e.dispose).toHaveBeenCalledOnce();wait.resolve(true);expect(await pending).toBeNull();expect(e.renderCapabilities).not.toHaveBeenCalled();expect(e.dispose).toHaveBeenCalledOnce();
 });
 it("pins input proof before an await and does not follow a later build's mutable metadata",async()=>{
  const e=fixture();const wait=deferred<boolean>();e.ready=vi.fn(()=>wait.promise);const mutable={...proof};const pending=probePhotoWebRenderer({proof:mutable,signal:new AbortController().signal,createEngine:()=>e});mutable.sdkVersion="later";mutable.manifestSha256="b".repeat(64);wait.resolve(true);const result=await pending;expect(result?.capability.sdkVersion).toBe("fixture");expect(result?.capability.manifestSha256).toBe(sha);expect(result?.engineAssets.manifestUrl()).toContain(sha);
 });
 it("closes for missing legacy getter, null capabilities, wrong crate, unavailable ready, and getter failure",async()=>{
  for(const make of [()=>({ready:vi.fn(async()=>true),dispose:vi.fn()}),()=>({...fixture(),renderCapabilities:vi.fn(async()=>null)}),()=>({...fixture(),renderCapabilities:vi.fn(async()=>({...caps,crateVersion:"9.0.0"}))}),()=>({...fixture(),ready:vi.fn(async()=>false)}),()=>({...fixture(),renderCapabilities:vi.fn(async()=>{throw Error("fixture failure")})})]){const e=make();expect(await probePhotoWebRenderer({proof,signal:new AbortController().signal,createEngine:()=>e})).toBeNull();expect(e.dispose).toHaveBeenCalledOnce();if (!("renderCapabilities" in e)) expect(e.ready).not.toHaveBeenCalled();}
 });
 it("closes if disposal fails and never publishes the binding",async()=>{
  const e=fixture();e.dispose=vi.fn(()=>{throw Error("fixture disposal failure")});expect(await probePhotoWebRenderer({proof,signal:new AbortController().signal,createEngine:()=>e})).toBeNull();
 });
 it("rejects another origin, metadata path mismatch, credentials, query, fragment and invalid hash before creating an engine",async()=>{
  const credentialUrl=new URL(proof.manifestUrl,location.origin);credentialUrl.username="fixture-user";
  for(const changed of [{manifestUrl:"https://upstream.invalid/x"},{manifestUrl:"/photo-build.json"},{manifestUrl:credentialUrl.href},{manifestUrl:proof.manifestUrl+"?x=1"},{manifestUrl:proof.manifestUrl+"#x"},{manifestSha256:"invalid"}]){const make=vi.fn(()=>fixture());expect(await probePhotoWebRenderer({proof:{...proof,...changed},signal:new AbortController().signal,createEngine:make})).toBeNull();expect(make).not.toHaveBeenCalled();}
 });
 it("disposes and drops a capability that arrives after scope invalidation",async()=>{
  const e=fixture();const wait=deferred<typeof caps>();e.renderCapabilities=vi.fn(()=>wait.promise);const c=new AbortController();const pending=probePhotoWebRenderer({proof,signal:c.signal,createEngine:()=>e});await Promise.resolve();c.abort();expect(e.dispose).toHaveBeenCalledOnce();wait.resolve(caps);expect(await pending).toBeNull();
 });
});

describe("createPhotoWebMaskSurfaceValidator",()=>{
 it("uses the pinned shared SDK decoder and ties release/cancellation to the Photo scope",async()=>{
  const dispose=vi.fn();const validate=vi.fn(async()=>({id:"a".repeat(64),width:8,height:4}));
  const engine={ready:vi.fn(async()=>true),dispose,validateMaskSurface:validate};
  const signal=new AbortController();const manifestUrl=proof.manifestUrl;
  const validator=await createPhotoWebMaskSurfaceValidator({engineAssets:{manifestUrl:()=>manifestUrl,preferNative:false},signal:signal.signal,createEngine:url=>{expect(url).toBe(manifestUrl);return engine;}});
  expect(validator).not.toBeNull();await expect(validator!.validateMaskSurface(new Uint8Array([1]))).resolves.toEqual({id:"a".repeat(64),width:8,height:4});
  signal.abort(new Error("scope revoked"));expect(dispose).toHaveBeenCalledOnce();await expect(validator!.validateMaskSurface(new Uint8Array([1]))).rejects.toThrow("scope revoked");
  validator!.dispose();expect(dispose).toHaveBeenCalledOnce();
 });
 it("does not publish a validator when the pinned runtime has no decoder or cannot start",async()=>{
  for(const engine of [
   {ready:vi.fn(async()=>true),dispose:vi.fn()},
   {ready:vi.fn(async()=>false),dispose:vi.fn(),validateMaskSurface:vi.fn(async()=>({id:"a".repeat(64),width:1,height:1}))},
  ]){
   expect(await createPhotoWebMaskSurfaceValidator({engineAssets:{manifestUrl:()=>proof.manifestUrl,preferNative:false},signal:new AbortController().signal,createEngine:()=>engine})).toBeNull();
   expect(engine.dispose).toHaveBeenCalledOnce();
  }
 });
});
