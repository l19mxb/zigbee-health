/** Synthetic residential panel examples, reachable only in isolated simulation. */
export function pulseSecurityDemo(engine,security){
  if(!engine.demo||!security.demo)throw Error('Security demonstration data requires simulation');
  const byName=new Map(engine.s.devices().map(device=>[device.name,device]));
  for(const [name,payload] of [
    ['Front door contact',{contact:true}],['Living room motion',{occupancy:false}],
    ['Back door contact',{contact:true}],['Kitchen motion',{contact:true,occupancy:false}],
    ['Study sensor',{contact:true}],['Bedroom 1',{occupancy:false}],
    ['Garage sensor',{contact:true}],['Landing 1',{contact:true}],
  ]){
    const device=byName.get(name);if(device)security.ingest(device.id,payload,{retain:false,at:engine.now()});
  }
}

export function seedSecurityDemo(engine,security){
  if(!engine.demo||!security.demo)throw Error('Security demonstration data requires simulation');
  const store=engine.s;
  if(!store.get('securityDemoSeeded')&&!security.areas().length){
    const byName=new Map(store.devices().map(device=>[device.name,device]));
    const house=security.saveArea({name:'House',entryDelaySec:30,exitDelaySec:45},'Simulation');
    const garage=security.saveArea({name:'Garage',entryDelaySec:0,exitDelaySec:0},'Simulation');
    const office=security.saveArea({name:'Garden office',entryDelaySec:20,exitDelaySec:30},'Simulation');
    for(const [area,name,deviceName,property,value,type,homeBypass] of [
      [house,'Front door','Front door contact','contact',false,'entry',false],
      [house,'Hall motion','Living room motion','occupancy',true,'instant',true],
      [house,'Kitchen window','Back door contact','contact',false,'instant',false],
      [house,'Side door','Kitchen motion','contact',false,'entry',false],
      [house,'Rear window','Study sensor','contact',false,'instant',false],
      [house,'Dining motion','Bedroom 1','occupancy',true,'instant',true],
      [garage,'Garage door','Garage sensor','contact',false,'instant',false],
      [office,'Office door','Landing 1','contact',false,'entry',false],
    ]){
      const device=byName.get(deviceName);if(device)security.saveZone({areaId:area.id,name,deviceId:device.id,property,value,type,homeBypass},'Simulation');
    }
    const days=[0,1,2,3,4,5,6];
    security.saveSchedule({name:'Evening Home mode',areaId:house.id,days,time:'22:00',mode:'home',enabled:false},'Simulation');
    security.saveSchedule({name:'Morning disarm',areaId:house.id,days,time:'07:00',mode:'disarmed',enabled:false},'Simulation');
    security.saveAction({name:'MQTT security event',areaId:house.id,kind:'mqtt',networkId:'demo-east',topic:'security/alerts',enabled:false},'Simulation');
    security.saveAction({name:'Security email',areaId:house.id,kind:'email',enabled:false},'Simulation');
    pulseSecurityDemo(engine,security);
    security.command(garage.id,'arm_away',{},'Simulation');
    store.set('securityDemoSeeded',true);
  }
  pulseSecurityDemo(engine,security);
}
