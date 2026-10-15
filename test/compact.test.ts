import { test, expect } from "bun:test"
import { compactSession } from "../src/compact.ts"
test("v2 RPC carries literal text and location; errors retain server reason", async () => {
 const calls: any[]=[]
 const client:any={rpc:()=>({compact:async(...args:any[])=>{calls.push(args);return {ok:false,error:"具体错误"}}})}
 await expect(compactSession({client,location:{directory:"/project"},sessionID:"s",fields:{instructions:"  原文\n"}})).rejects.toThrow("具体错误")
 expect(calls[0][0]).toEqual({sessionID:"s",instructions:"  原文\n"})
 expect(calls[0][1].location).toEqual({directory:"/project"})
})
test("RPC sends the selected provider, model, and variant without committing an ordinary prompt", async () => {
 const calls: any[]=[]
 const client:any={rpc:()=>({compact:async(...args:any[])=>{calls.push(args);return {ok:true}}})}
 const model={providerID:"new-provider",id:"new-model",variant:"max"}
 await compactSession({client,location:{directory:"/project"},sessionID:"s",fields:{instructions:""},model})
 expect(calls[0][0]).toEqual({sessionID:"s",instructions:"",model})
})
