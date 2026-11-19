'use strict';
module.exports=()=>({version:17,payload:{settings:{discountMethod:'Nominal',taxPercent:0},categories:['TEST'],units:['Kg'],paymentMethods:['Tunai','DP','Transfer'],
 products:[{id:'p',name:'Fractional product',stock:7.5,costPrice:2.25,retailPrice:10,wholesalePrice:8,trackStock:true,active:true,unit:'Kg'}],
 customers:[{id:'c',name:'Customer',address:'Historical address'}],suppliers:[{id:'s',name:'Supplier'}],
 transactions:[{id:'t',invoice:'959',createdAt:'2026-10-22T10:00:00.000Z',customer:'Customer',cashier:'ADMIN',paymentMethod:'DP',downPayment:5,cashIn:5,payment:5,change:0,subtotal:24,discountAmount:0,discountPercent:0,taxAmount:0,taxPercent:0,total:24,
 items:[{productId:'p',lineId:'line',name:'Old product name',unit:'Kg',price:10,discount:0.4,qty:2.5,costPrice:2,amount:24,profit:19}],
 paymentHistory:[{id:'pay1',date:'2026-10-23',amount:7.25,method:'Transfer',cashier:'CASHIER',note:'part payment'}],quantityEdits:[]}],
 incoming:[{id:'i',date:'2026-10-21',supplier:'Supplier',productId:'p',product:'Product',qty:10,purchasePrice:2.25,total:22.5,previousStock:0,previousCostPrice:2,resultingCostPrice:2.25}],
 stocktakes:[{id:'s1',date:'2026-10-21',productId:'p',product:'Product',systemStock:9,physicalStock:10,difference:1}]
}});
