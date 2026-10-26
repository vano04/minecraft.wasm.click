#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
extern void mcweb_commit_reserved(void*, size_t);
static void check_zero(const unsigned char* p, size_t n) {
  for (size_t i=0;i<n;i++) assert(p[i]==0);
}
int main(void) {
  size_t page=65536;
  unsigned char* guard=malloc(page);
  assert(guard);
  memset(guard,0xa5,page);
  mcweb_commit_reserved(guard,page);
  for(size_t i=0;i<page;i++) assert(guard[i]==0xa5);
  free(guard);
  for(int repeat=0;repeat<3;repeat++) {
    unsigned char* p=mmap(NULL,page*4,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    assert(p!=MAP_FAILED);check_zero(p,page*4);
    memset(p,0x7b,page*4);
    assert(msync(p,page*4,MS_SYNC)==0);
    assert(munmap(p,page*4)==0);
  }
  unsigned char* p=mmap(NULL,page*16,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  assert(p!=MAP_FAILED);
  mcweb_commit_reserved(p+page*15,page);
  check_zero(p+page*15,page);
  memset(p+page*15,0x6c,page);
  mcweb_commit_reserved(p,page);
  check_zero(p,page);
  for(size_t i=0;i<page;i++) assert(p[page*15+i]==0x6c);
  assert(munmap(p,page*16)==0);
  puts("PASS: anonymous maps zero on reuse; reserved subranges zero on commit; adjacent data and malloc stack cookies preserved; unmap/msync bookkeeping intact");
}
