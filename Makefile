CUDA_HOME ?= /usr/local/cuda
NVCC ?= nvcc
BUILD_DIR ?= build

.PHONY: cuda clean

cuda: $(BUILD_DIR)/pfft-cuda-miner

$(BUILD_DIR)/pfft-cuda-miner: cuda/pfft_cuda_miner.cu
	mkdir -p $(BUILD_DIR)
	$(NVCC) -O3 -std=c++17 -arch=native -o $@ $<

clean:
	rm -rf $(BUILD_DIR)
