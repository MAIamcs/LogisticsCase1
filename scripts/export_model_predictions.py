from pathlib import Path
import csv,json,sys,hashlib
root=Path.cwd();sys.path.insert(0,str(root/'backend'))
from app.congestion_model import CongestionModel
from app.model_schemas import ModelFeatures,ModelMetadata,ModelPredictionResponse
from app.forecast_provider import DemoForecastProvider
source=root/'contracts/model-training.csv'
rows=list(csv.DictReader(source.open(encoding='utf-8-sig')))
profiles={};groups={}
for r in rows:
 f={k:(int(r[k]) if k in ['hour','is_main_road','lanes_total','population'] else r[k]) for k in ['hour','district','is_main_road','day_of_week','season','lanes_total','population']}
 ModelFeatures(**f); p={k:f[k] for k in ['is_main_road','lanes_total','population']}
 if f['district'] in profiles: assert profiles[f['district']]==p
 profiles[f['district']]=p
 f['hour']=0;groups[json.dumps(f,sort_keys=True,ensure_ascii=False)]=f
(root/'contracts/model-profiles.json').write_text(json.dumps(profiles,ensure_ascii=False,indent=2)+'\n')
folder=root/'contracts/fixtures/model';folder.mkdir(exist_ok=True)
model=CongestionModel();metadata=model.metadata(DemoForecastProvider().get_metadata().geography)
metadata.disclaimer='Расчётный индекс дорожного профиля CatBoost. Модель использует час, район, тип дороги, день недели, сезон, полосность и население.'
metadata.season_suggestions=sorted({r['season'] for r in rows})
next(f for f in metadata.features if f.name=='season').options=metadata.season_suggestions
results=[]
for f in groups.values():
 result=model.predict(ModelFeatures(**f),True)
 result.warnings=[metadata.disclaimer,'Профиль дороги из обучающего CSV; оценка не является измерением всех дорог района.']
 ModelPredictionResponse.model_validate(result.model_dump());results.append(result.model_dump(mode='json'))
(folder/'metadata.json').write_text(metadata.model_dump_json(indent=2)+'\n')
(folder/'predictions.json').write_text(json.dumps(results,ensure_ascii=False,separators=(',',':'))+'\n')
(folder/'provenance.json').write_text(json.dumps({'source':source.name,'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'rows':len(rows),'districts':len(profiles),'profile_count':len(results),'model_sha256':model.model_sha256,'retrained':False},indent=2)+'\n')
print(len(results),len(profiles))
