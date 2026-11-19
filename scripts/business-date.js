'use strict';
const TIME_ZONE='Asia/Jakarta';
function businessDate(timestamp){
  if(typeof timestamp!=='string'||!/(Z|[+-]\d{2}:\d{2})$/i.test(timestamp)||Number.isNaN(Date.parse(timestamp)))throw new Error('Historical timestamp requires an explicit UTC offset: '+timestamp);
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));
  const part=k=>parts.find(p=>p.type===k).value;return `${part('year')}-${part('month')}-${part('day')}`;
}
module.exports={businessDate,TIME_ZONE};
