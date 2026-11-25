import Link from 'next/link';
export function Heading({title,description}:{title:string;description:string}){return <div className="heading"><div><div className="eyebrow">Workspace</div><h1>{title}</h1><p>{description}</p></div></div>}
export function Card({title,children,id}:{title:string;children:React.ReactNode;id?:string}){return <section className="card" id={id}><h2>{title}</h2>{children}</section>}
export function Empty({children}:{children:React.ReactNode}){return <div className="empty">{children}</div>}
export function ErrorNotice({error}:{error?:string|null}){return error?<div className="notice error" role="alert">{error}</div>:null}
export function ProjectLink({id,title}:{id:string;title:string}){return <Link href={`/projects/${id}`}>{title}</Link>}
