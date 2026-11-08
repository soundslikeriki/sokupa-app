import test from 'node:test';
import assert from 'node:assert/strict';
import {numericalOrderStatus} from './order-quantity-status';
import {planMemoOrder} from './order-planning';
const base={ordered:51,required:'50.7',inputsComplete:true,conditionsKnown:true};
test('read-only numerical check compares strict required length, independently of reserve recommendation and manual acknowledgements',()=>{
 const item={product_code:'SYN',manufacturer:'Synthetic',entries:[{original_formula:'50.7×1',length_m:50.7,quantity:1,subtotal_m:50.7}],total_m:50.7,order_quantity:60};
 const plan=planMemoOrder({item,rows:[{id:'a',length:50.7,quantity:1,active:false}],repeatCm:null,basis:'unconfirmed',match:'unconfirmed',lossRate:18,manualQuantity:51});
 assert.equal(plan.comparison.strict.totals.selectedM,'50.7');assert.equal(plan.automaticQuantity,60);assert.equal(plan.ready,true);assert.equal(plan.confirmed,false);
 const before=JSON.stringify(plan);assert.equal(numericalOrderStatus(base).state,'sufficient');assert.equal(JSON.stringify(plan),before);assert.equal(plan.confirmed,false);
 assert.equal(numericalOrderStatus({...base,ordered:0}).state,'shortfall');
 assert.equal(numericalOrderStatus({...base,ordered:50}).text,'0.7m不足（必要 50.7m）');
 assert.equal(numericalOrderStatus({...base,ordered:50.7}).state,'sufficient');
 assert.equal(numericalOrderStatus({...base,ordered:60}).state,'sufficient');
});
test('unknown strict requirement never passes using displayed reference/recommended quantities',()=>{
 const item={product_code:'SYN',manufacturer:'Synthetic',order_mode:'pattern' as const,entries:[{original_formula:'2.7×2',length_m:2.7,quantity:2,subtotal_m:5.4,repeat_enabled:true}],total_m:6,order_quantity:7};
 const plan=planMemoOrder({item,rows:[{id:'a',length:2.7,quantity:2,active:true}],repeatCm:60,basis:'unconfirmed',match:'straight',lossRate:15});
 assert.equal(plan.comparison.strict.totals.selectedM,null);assert.equal(plan.totalM,6);assert.equal(plan.automaticQuantity,7);
 for(const change of [{required:null},{conditionsKnown:false},{inputsComplete:false},{ordered:NaN},{ordered:Infinity},{required:'0'},{required:'1e2'},{required:'-1'},{required:'50.7㎡'}])assert.equal(numericalOrderStatus({...base,...change}).state,'unknown');
});
test('reading warnings never hide a calculable comparison or block a valid chosen quantity',()=>{
 const item={product_code:'SYN',manufacturer:'Synthetic',needs_review:true,entries:[{original_formula:'50.7×1',length_m:50.7,quantity:1,subtotal_m:50.7,needs_review:true}],total_m:50.7,order_quantity:51,reading_reviews:[{reason:'判読が難しい訂正箇所を照合',candidate_formulas:['1×2']}]};
 const input={item,rows:[{id:'a',length:50.7,quantity:1,active:false}],repeatCm:null,basis:'unconfirmed',match:'unconfirmed',lossRate:18,manualQuantity:51};
 const plan=planMemoOrder(input);assert.equal(plan.comparison.strict.totals.selectedM,'50.7');assert.equal(plan.ready,true);assert.equal(plan.readingReviewConfirmed,false);
 assert.equal(numericalOrderStatus({...base,required:plan.comparison.strict.totals.selectedM}).state,'sufficient');
 assert.equal(numericalOrderStatus({...base,ordered:50,required:plan.comparison.strict.totals.selectedM}).text,'0.7m不足（必要 50.7m）');
 assert.equal(item.reading_reviews.length,1);assert.equal(planMemoOrder({...input,readingReviewConfirmation:plan.readingReviewFingerprint}).ready,true);
});
test('exact decimal shortage, equality and excess use metres with no tolerance or rounding into a pass',()=>{
 assert.equal(numericalOrderStatus({...base,ordered:1,required:'1.000001'}).text,'0.000001m不足（必要 1.000001m）');
 assert.equal(numericalOrderStatus({...base,ordered:1.000001,required:'1.000001'}).state,'sufficient');
 assert.equal(numericalOrderStatus({...base,ordered:1.000002,required:'1.000001'}).state,'sufficient');
 assert.equal(numericalOrderStatus({...base,ordered:-1}).state,'unknown');
});
