export function recordingListPath(filters:{device:string;status:string;date:string;search:string;cursor:string}) {
 const q=new URLSearchParams({limit:'25'});
 if(filters.device)q.set('device_id',filters.device);
 if(filters.status)q.set('status',filters.status);
 if(filters.search.trim())q.set('search',filters.search.trim());
 if(filters.cursor)q.set('cursor',filters.cursor);
 if(filters.date){const start=new Date(`${filters.date}T00:00:00`);const end=new Date(`${filters.date}T00:00:00`);end.setDate(end.getDate()+1);if(Number.isFinite(start.getTime())){q.set('from',start.toISOString());q.set('to',new Date(end.getTime()-1).toISOString());}}
 return `/files?${q}`;
}
