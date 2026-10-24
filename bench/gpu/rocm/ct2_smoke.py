import ctranslate2
print("ct2", ctranslate2.__version__, "cuda devices", ctranslate2.get_cuda_device_count())
print("compute types", ctranslate2.get_supported_compute_types("cuda"))
