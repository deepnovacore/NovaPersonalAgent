/** Local, bounded hints only: never record these guesses as personal facts. */
export function lifestyleNewsInterests(texts:readonly string[],language='en'):string[]{
 const cues:[string,string,RegExp][]=[
  ['健康','Health',/健康|健身|睡眠|营养|\b(?:health|fitness|sleep|nutrition)\b/iu],
  ['美食','Food',/美食|烹饪|做饭|食谱|\b(?:cooking|recipes?|food)\b/iu],
  ['旅行','Travel',/旅行|旅游|徒步|\b(?:travel|hiking)\b/iu],
  ['体育','Sport',/足球|篮球|网球|跑步|游泳|体育|\b(?:football|basketball|tennis|running|swimming|sports?)\b/iu],
  ['文化艺术','Arts and culture',/艺术|博物馆|文学|读书|\b(?:arts?|museums?|literature|reading)\b/iu],
  ['音乐电影','Music and film',/音乐|电影|演唱会|\b(?:music|films?|cinema|concerts?)\b/iu],
  ['园艺','Gardening',/园艺|种花|\bgardening\b/iu],
  ['宠物','Pets',/宠物|养猫|养狗|\bpets?\b/iu],
 ]
 const result:string[]=[]
 for(const text of texts.slice(-40).reverse())for(const [zh,en,pattern]of cues)if(pattern.test(text.slice(0,1000))){const label=/^zh/iu.test(language)?zh:en;if(!result.includes(label))result.push(label)}
 return result.slice(0,8)
}
