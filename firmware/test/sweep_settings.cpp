// Tries detector settings on simulated signals and a real RAW capture. Build after copying
// ../esp32/pulse_detector.h to pd_try.h with the setting changed:
//   g++ -std=c++17 -O2 -I. sweep_settings.cpp -o sweep && ./sweep capture.txt
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "pd_try.h"
static float gauss(){float u=(rand()+1.0f)/(RAND_MAX+2.0f),v=(rand()+1.0f)/(RAND_MAX+2.0f);return sqrtf(-2*logf(u))*cosf(6.2831853f*v);}
static float shape(float ph){return expf(-powf((ph-0.18f)/0.07f,2))+0.6f*expf(-powf((ph-0.45f)/0.08f,2));}
static void sim(float bpm,float noise,bool motion,int*ob,int*os){srand(3);PulseDetector pd;float ph=0;for(int n=0;n<3000;n++){ph+=bpm/6000;if(ph>=1)ph-=1;float p=shape(ph),d=1+0.01f*sinf(n*0.004f);float ir=110000*d*(1-0.004f*p)+noise*gauss(),red=90000*d*(1-0.004f*0.593f*p)+noise*gauss();if(motion&&(n%700)>600&&(n%700)<640){ir+=2500*sinf(n*0.9f);red+=2000*sinf(n*0.9f);}pd.update(ir,red,10*n);}*ob=pd.bpm;*os=pd.spo2;}
static void real(const char*f,int*ob,int*os,int*good){FILE*fp=fopen(f,"r");char l[128];PulseDetector pd;double t=0;*good=0;int lastb=0,lasts=0;while(fgets(l,sizeof l,fp)){unsigned long ir,red;if(sscanf(l,"R,%lu,%lu",&ir,&red)!=2)continue;t+=1000.0/103.5;if(pd.update(ir,red,(uint32_t)t))(*good)++;if(pd.bpm){lastb=pd.bpm;lasts=pd.spo2;}}fclose(fp);*ob=lastb;*os=lasts;}
int main(int c,char**v){int b,s,g;
 sim(72,40,false,&b,&s);printf("sim 72: %d/%d  ",b,s);sim(140,40,false,&b,&s);printf("sim 140: %d/%d  ",b,s);sim(80,60,true,&b,&s);printf("sim 80+move: %d/%d  ",b,s);sim(55,120,false,&b,&s);printf("sim 55 noisy: %d/%d  ",b,s);
 real(v[1],&b,&s,&g);printf("| REAL: last %d bpm %d%% (%d estimates)\n",b,s,g);}
