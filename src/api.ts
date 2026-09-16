export type Session = {id:string;name:string;createdAt?:number};
export class ApiError extends Error {constructor(public status:number,message:string){super(message)}}
export async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
 const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 const value=await response.json().catch(()=>({}));
 if(!response.ok)throw new ApiError(response.status,value.error||'连接暂时不可用');return value;
}
