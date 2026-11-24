import { validateRules } from "./rules.js";
const root=document.getElementById("visual-rules"), raw=document.getElementById("rule-json"), status=document.getElementById("visual-status");
const metrics="price liquidity volume24h change24h buyPressure transactionVelocity positionProfit drawdown holdingMinutes utcHour sma ema rsi bollingerUpper bollingerLower vwap atrPercent breakoutHigh breakoutLow volumeSpike candleBodyPercent bullishCandles bearishCandles pullbackPercent candleChange positionAdds poolAgeMinutes liquidityChange liquidityToSize profitGiveback maCross".split(" ");
let tree;
function el(tag,text){const e=document.createElement(tag);if(text)e.textContent=text;return e;}
function choice(values,value,change){const e=el("select");for(const v of values){const o=el("option",v);o.value=v;e.append(o);}e.value=value;e.onchange=()=>change(e.value);return e;}
function number(value,change){const e=el("input");e.type="number";e.step="any";e.value=value;e.oninput=()=>change(e.value===""?NaN:Number(e.value));return e;}
function field(label,input){const e=el("label",label);e.append(input);return e;}
function button(label,action){const b=el("button",label);b.type="button";b.className="secondary";b.onclick=action;return b;}
const leaf=()=>({metric:"rsi",period:14,compare:"lt",value:30});
function sync(){try{const valid=validateRules(tree);raw.value=JSON.stringify({entry:valid.entry,exit:valid.exit},null,2);status.textContent="Ehdot kelvolliset. Tallenna ehtopuut.";}catch(e){status.textContent=e.message;}}
function renderNode(node,replace,remove,depth=0){const box=el("fieldset");const group=!!node.op;
box.append(choice(["Ehto","AND","OR","NOT"],node.op??"Ehto",v=>{replace(v==="Ehto"?leaf():{op:v,children:[group?node.children[0]:node]});render();}));
if(group){node.children.forEach((child,i)=>box.append(renderNode(child,v=>node.children[i]=v,node.children.length>1?()=>node.children.splice(i,1):null,depth+1)));if(node.op!=="NOT"&&depth<7)box.append(button("Lisää ehto",()=>{node.children.push(leaf());render();}));}
else {box.append(field("Mittari",choice(metrics,node.metric,v=>{node.metric=v;render();})),field("Jakso",number(node.period??14,v=>{node.period=v;sync();})),field("Vertailu",choice(["gt","gte","lt","lte","eq"],node.compare,v=>{node.compare=v;sync();})));
if(node.metric==="maCross"){box.append(field("Nopea jakso",number(node.fast??5,v=>{node.fast=v;sync();})),field("Kynttilöiden sisällä",number(node.within??1,v=>{node.within=v;sync();})),field("Keskiarvo",choice(["EMA","SMA"],node.average??"EMA",v=>{node.average=v;sync();})),field("Suunta",choice(["up","down"],node.direction??"up",v=>{node.direction=v;sync();})));}
if(typeof node.value==="number")box.append(field("Raja-arvo",number(node.value,v=>{node.value=v;sync();})));else box.append(el("p","Mittarivertailu säilytetään JSON-muodossa."));
}
if(remove)box.append(button("Poista",()=>{remove();render();}));return box;}
function render(){root.replaceChildren();for(const [key,label] of [["entry","Ostoehdot"],["exit","Myyntiehdot"]]){root.append(el("h2",label),renderNode(tree[key],v=>tree[key]=v,null));}sync();}
document.getElementById("visual-load").onclick=()=>{try{tree=validateRules(JSON.parse(raw.value));render();}catch(e){status.textContent=e.message;}};
status.textContent="Lataa nykyiset ehdot aloittaaksesi. Muutokset tallennetaan nykyisellä Tallenna ehtopuut -painikkeella.";
